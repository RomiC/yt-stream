import { Streamlink } from './streamlink.js';
import { Event } from './events.js';
import { Ffmpeg } from './ffmpeg.js';
import { Icecast, IcecastUnreachableError } from './icecast.js';
import { TTLWatcher } from './ttlWatcher.js';
import { redactProxy } from './utils/redactProxy.js';
import { getYoutubeMeta } from './utils/getYoutubeMeta.js';

const MOUNTPOINT_TIMEOUT = 30_000; // streamlink open + ffmpeg connecting to Icecast
const POLL_INTERVAL = 500;
const START_ATTEMPTS = 3; // each attempt re-picks the proxy

/**
 * One stream generation: owns its own streamlink/ffmpeg processes, the TTL
 * watcher and the Icecast client, plus the url/startedAt identity. Its phase
 * is derived from its own process liveness and Icecast readiness, so it is
 * self-describing. It emits no events — Stream observes it via
 * onExit/onExpired. It logs only its per-attempt starts, through the shared logger.
 */
export class StreamPipeline {
  #id;
  #url;
  #startedAt;
  #streamlink;
  #ffmpeg;
  #ttlWatcher;
  #icecast;
  #mountpointTimeout;
  #pollInterval;
  #startAttempts;
  #proxies;
  #logger;
  #ready = false;
  #lastProxy = null;
  #exitCallbacks = [];
  #lastExit = null;

  constructor({ id, url, streamlinkQuality, proxies, streamTtlMinutes, icecast, logger, timeouts = {} }) {
    this.#id = id;
    this.#url = url;
    this.#startedAt = null;
    this.#mountpointTimeout = timeouts.mountpointTimeout ?? MOUNTPOINT_TIMEOUT;
    this.#pollInterval = timeouts.pollInterval ?? POLL_INTERVAL;
    this.#startAttempts = Math.max(1, timeouts.startAttempts ?? START_ATTEMPTS);
    this.#proxies = proxies;
    this.#logger = logger;
    this.#streamlink = new Streamlink({ streamlinkQuality });
    this.#ffmpeg = new Ffmpeg();
    this.#ttlWatcher = new TTLWatcher({ streamTtlMinutes, icecast });
    this.#icecast = icecast;

    this.#streamlink.onExit((exit) => this.#onWrapperExit(this.#streamlink, exit));
    this.#ffmpeg.onExit((exit) => this.#onWrapperExit(this.#ffmpeg, exit));
  }

  get id() {
    return this.#id;
  }

  get url() {
    return this.#url;
  }

  get startedAt() {
    return this.#startedAt;
  }

  /** Derived from process liveness + Icecast readiness. */
  get phase() {
    if (!this.#streamlink.isAlive() || !this.#ffmpeg.isAlive()) {
      return 'stopped';
    }
    return this.#ready ? 'streaming' : 'starting';
  }

  get streamlink() {
    return this.#streamlink;
  }

  get ffmpeg() {
    return this.#ffmpeg;
  }

  get ttlWatcher() {
    return this.#ttlWatcher;
  }

  /** Proxy picked for the latest attempt, already redacted — for logging. */
  get lastProxy() {
    return this.#lastProxy;
  }

  /** Subscribes to an unexpected exit of either process (owner kills stay silent). */
  onExit(callback) {
    this.#exitCallbacks.push(callback);
  }

  /** Subscribes to zero-listener TTL expiry. */
  onExpired(callback) {
    this.#ttlWatcher.onExpired(callback);
  }

  /** True once a start attempt has fully succeeded — mid-start exits belong to the retry loop. */
  get hasStarted() {
    return this.#startedAt !== null;
  }

  isStreaming() {
    return this.phase === 'streaming';
  }

  /**
   * Spawns streamlink + ffmpeg, pipes them, then waits until the Icecast
   * mount is active (proof the pipeline works end-to-end). Up to
   * `startAttempts` attempts; each one re-picks the proxy (a poisoned exit
   * no longer burns the whole budget) and both processes are torn down
   * between attempts. Fails fast with attribution if a process dies or
   * Icecast drops; throws if the mount never becomes active within the budget.
   */
  async start(sourceUrl) {
    this.#ready = false;
    // Per-request rotation: created, consumed, and discarded within this start.
    const proxyRotation = this.#proxies.pickProxies();
    let lastError;
    for (let attempt = 1; attempt <= this.#startAttempts; attempt++) {
      try {
        await this.#startAttempt(sourceUrl, attempt, proxyRotation.next().value ?? null);
        this.#ready = true;
        this.#startedAt = Date.now();
        return;
      } catch (err) {
        lastError = err;
        await this.#killProcesses();
      }
    }
    throw lastError;
  }

  async #startAttempt(sourceUrl, attempt, proxy) {
    this.#lastExit = null;
    this.#lastProxy = proxy ? redactProxy(proxy) : null;
    this.#logger.info({ attempt, maxAttempts: this.#startAttempts, proxy: this.#lastProxy }, 'starting streamlink');
    await this.#streamlink.spawnProcess(this.#url, proxy);
    await this.#ffmpeg.spawnProcess(sourceUrl);
    this.#streamlink.pipe(this.#ffmpeg);
    await this.#waitReady();
  }

  /** Kills both processes (owner kills — their exits stay silent). */
  async #killProcesses() {
    await this.#streamlink.kill();
    await this.#ffmpeg.kill();
  }

  /** Idempotent stop: kills its own processes and stops its watcher. */
  async stop() {
    await this.#killProcesses();
    this.#ttlWatcher.stop();
  }

  /** Liveness snapshot for /health. */
  getStatus() {
    return {
      streamlink: { status: this.#streamlink.isAlive() ? 'running' : 'stopped' },
      ffmpeg: { status: this.#ffmpeg.isAlive() ? 'running' : 'stopped' }
    };
  }

  async #waitReady() {
    const deadline = Date.now() + this.#mountpointTimeout;
    while (true) {
      if (!this.#streamlink.isAlive() || !this.#ffmpeg.isAlive()) {
        throw this.#exitError(this.#lastExit);
      }
      const status = await this.#icecast.getStatus();
      if (!status.icecastReachable) {
        throw new IcecastUnreachableError();
      }
      if (status.mountpointActive) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('mountpoint never became active');
      }
      await sleep(Math.min(this.#pollInterval, deadline - Date.now()));
    }
  }

  #onWrapperExit(wrapper, exit) {
    this.#lastExit = { wrapper, exit };
    for (const callback of this.#exitCallbacks) {
      callback(wrapper, exit);
    }
  }

  #exitError({ wrapper, exit }) {
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
    const tail = exit.errors.split('\n').slice(-3).join(' | ');
    return new Error(
      `${wrapper.command} exited before the mountpoint became active (${how})${tail ? `: ${tail}` : ''}`
    );
  }
}

/**
 * Orchestrates the pipeline: streamlink → ffmpeg → Icecast.
 *
 * No state machine — the active generation is a StreamPipeline held in
 * `#current` (live pipelines live in `#pipelines`, keyed by id; a stepping
 * stone to multi-stream). Control flow is sequential async/await; background
 * concerns (process exits, TTL) are observed directly per pipeline. The bus
 * carries only outward stream:* notifications; the shared logger is passed
 * to collaborators that report their own facts (pipeline attempts, Icecast polls).
 */
export class Stream {
  #logger;
  #icecast;
  #events;
  #timeouts;
  #pipelineId = 0;
  #streamlinkOptions;
  #streamTtlMinutes;
  #pipelines = new Map();
  // Sets whose teardown has been accounted — a repeated teardown (e.g. a late
  // process-exit after a manual stop) must not emit stream:stopped twice.
  #finalizedSets = new WeakSet();
  #current = null;
  #lastUrl = null;

  constructor({ config, logger, events, proxies, timeouts = {} }) {
    this.#logger = logger;
    this.#events = events;
    this.#timeouts = timeouts;
    this.#streamlinkOptions = {
      streamlinkQuality: config.streamlinkQuality,
      proxies
    };
    this.#streamTtlMinutes = config.streamTtlMinutes;
    this.#icecast = new Icecast({
      host: config.icecast.host,
      port: config.icecast.port,
      sourcePassword: config.icecast.sourcePassword,
      adminPassword: config.icecast.adminPassword,
      publicBaseUrl: config.publicBaseUrl,
      logger
    });
  }

  #createSet(url) {
    const set = new StreamPipeline({
      id: ++this.#pipelineId,
      url,
      ...this.#streamlinkOptions,
      streamTtlMinutes: this.#streamTtlMinutes,
      icecast: this.#icecast,
      logger: this.#logger,
      timeouts: this.#timeouts
    });
    set.onExit((wrapper, exit) => this.#onProcessExited(set, wrapper, exit));
    set.onExpired(() => this.#onTtlExpired(set));
    this.#pipelines.set(set.id, set);
    return set;
  }

  #discardPipeline(set) {
    this.#pipelines.delete(set.id);
  }

  /**
   * Tears down `set` (its own processes), removes it from the live-pipelines
   * map, and — only if it is still the current stream and was streaming —
   * emits stream:stopped. Liveness is judged by hasStarted: a crashed
   * process already reads as phase 'stopped', so isStreaming() would swallow
   * the stop event for the very crashes it reports. Finalized sets are
   * skipped — their stop event has been accounted (or was never eligible).
   */
  async #stopPipeline(set = this.#current, reason) {
    if (!set || this.#finalizedSets.has(set)) {
      return;
    }
    // Captured before stop(): mid-await a concurrent teardown (TTL racing a
    // replace) must still see the live set.
    const isLiveStream = set.hasStarted;
    await set.stop();
    this.#finalizedSets.add(set);
    this.#discardPipeline(set);
    if (this.#current === set && isLiveStream) {
      this.#current = null;
      this.#events.emit(Event.streamStopped, { reason, url: set.url });
    }
  }

  async #onProcessExited(set, wrapper, exit) {
    // Mid-start exits are owned by the start retry loop (rotation + attribution).
    if (!set.hasStarted) {
      return;
    }
    const { how, tail } = this.#exitFacts(exit);
    this.#logger.error({ cmd: wrapper.command, exit: how, tail }, 'unexpected process exit');
    await this.#stopPipeline(set, 'process-exit');
  }

  async #onTtlExpired(set) {
    await this.#stopPipeline(set, 'ttl');
  }

  /**
   * Start (or replace) a stream for a YouTube URL. Throws on failure — the
   * HTTP layer maps that to a 500. No hidden retries.
   */
  async start(youtubeUrl) {
    if (this.#current && this.#current.isStreaming() && this.#current.url === youtubeUrl) {
      return; // same URL already streaming
    }

    this.#lastUrl = youtubeUrl;

    if (this.#current) {
      const old = this.#current;
      await this.#stopPipeline(old, 'replaced');
    }

    try {
      await this.#icecast.prepareMountPoint();
      const set = this.#createSet(youtubeUrl);
      this.#current = set;

      await set.start(this.#icecast.sourceUrl);
      set.ttlWatcher.watch(youtubeUrl);

      this.#updateMetadata(youtubeUrl);
      this.#events.emit(Event.streamStarted, { url: youtubeUrl });
    } catch (err) {
      this.#logger.error({ err: err.message, proxy: this.#current?.lastProxy ?? null }, 'failed to start stream');
      const failed = this.#current;
      await this.#stopPipeline(failed, 'start-failed');
      this.#current = null;
      this.#events.emit(Event.streamError, { url: youtubeUrl, error: err.message });
      throw err;
    }
  }

  async stop() {
    if (!this.#current) {
      return;
    }
    const set = this.#current;
    // #stopPipeline nulls #current on the emit; /health falls back to #lastUrl.
    await this.#stopPipeline(set, 'manual');
  }

  async #updateMetadata(youtubeUrl) {
    const metadata = await getYoutubeMeta(youtubeUrl);

    this.#logger.info(
      metadata && { title: metadata.title, author_name: metadata.author_name },
      'Stream metadata fetched'
    );

    if (metadata && this.#current && this.#current.phase === 'streaming' && this.#current.url === youtubeUrl) {
      const title = `${metadata.author_name} - ${metadata.title}`;

      await this.#icecast.setMetadata(title);
    }
  }

  #exitFacts(exit) {
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
    const tail = exit.errors.split('\n').slice(-3).join(' | ');
    return { how, tail };
  }

  /**
   * Public audio mount URL the client is redirected to after a successful
   * start (proxied to Icecast, which owns the mount).
   */
  get streamUrl() {
    return this.#icecast.streamUrl;
  }

  /**
   * Fetches the current state and builds the snapshot for /health: each
   * process's liveness, Icecast availability/state/listener count, and the
   * general stream state + URL. Independent of the TTL watcher.
   */
  async getStatus() {
    const icecastStatus = await this.#icecast.getStatus();
    const set = this.#current;
    return {
      ...(set ? set.getStatus() : { streamlink: { status: 'stopped' }, ffmpeg: { status: 'stopped' } }),
      icecast: {
        status: icecastStatus.icecastReachable ? 'available' : 'unavailable',
        state: icecastStatus.mountpointActive ? 'streaming' : 'stopped',
        listeners: icecastStatus.listeners
      },
      general: {
        state: set ? set.phase : 'idle',
        url: set?.url ?? this.#lastUrl ?? null
      }
    };
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

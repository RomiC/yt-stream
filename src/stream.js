import { Streamlink } from './streamlink.js';
import { Event } from './events.js';
import { Ffmpeg } from './ffmpeg.js';
import { Icecast, IcecastUnreachableError } from './icecast.js';
import { TTLWatcher } from './ttlWatcher.js';

const MOUNTPOINT_TIMEOUT = 30_000; // streamlink open + ffmpeg connecting to Icecast
const POLL_INTERVAL = 500;

/**
 * Orchestrates a single stream: streamlink → ffmpeg → Icecast.
 *
 * No state machine — the state is a plain in-memory object (`current`) and
 * control flow is sequential `async/await`. Background concerns are observed
 * directly: process wrappers report unexpected exits via `onExit`, the TTL
 * watcher via `onExpired`. The bus carries only outward stream:*
 * notifications.
 *
 * `current` = null (idle) or
 *   { url, phase: 'starting'|'streaming'|'stopped', startedAt }
 */
export class Stream {
  #logger;
  #icecast;
  #streamlink;
  #ffmpeg;
  #events;
  #current = null;
  #lastUrl = null;
  #ttlWatcher;
  #mountpointTimeout;
  #pollInterval;
  // Mid-start failure attribution: { wrapper, exit } recorded by onExit, read by #awaitStreamReadiness.
  #unexpectedExit = null;

  constructor({ config, logger, events, timeouts = {} }) {
    this.#logger = logger;
    this.#events = events;
    this.#mountpointTimeout = timeouts.mountpointTimeout ?? MOUNTPOINT_TIMEOUT;
    this.#pollInterval = timeouts.pollInterval ?? POLL_INTERVAL;
    // The stream service owns its collaborators and can report its own
    // health; nothing outside Stream needs them.
    this.#icecast = new Icecast({
      host: config.icecast.host,
      port: config.icecast.port,
      sourcePassword: config.icecast.sourcePassword,
      adminPassword: config.icecast.adminPassword,
      publicHostname: config.publicHostname,
      publicPort: config.icecast.publicPort,
      logger
    });
    this.#streamlink = new Streamlink({
      streamlinkQuality: config.streamlinkQuality,
      proxyList: config.proxyList
    });
    this.#ffmpeg = new Ffmpeg();
    this.#ttlWatcher = new TTLWatcher({ config, logger, icecast: this.#icecast });

    // Deliberate kills never fire onExit — the wrappers swallow closes of
    // processes we killed ourselves.
    this.#streamlink.onExit((exit) => this.#onProcessExited(this.#streamlink, exit));
    this.#ffmpeg.onExit((exit) => this.#onProcessExited(this.#ffmpeg, exit));

    // TTLWatcher stops itself on expiry and notifies; Stream tears down.
    this.#ttlWatcher.onExpired(() => this.#onTtlExpired());
  }

  /**
   * Kills both processes; the phase guard makes the stop idempotent and
   * skips streams that never announced themselves with stream:started.
   */
  async #stopPipeline(reason) {
    await this.#streamlink.kill();
    await this.#ffmpeg.kill();
    if (this.#current?.phase === 'streaming') {
      this.#current.phase = 'stopped';
      this.#current.startedAt = null;
      this.#events.emit(Event.streamStopped, { reason, url: this.#current.url });
    }
  }

  async #onProcessExited(wrapper, exit) {
    const { how, tail } = this.#exitFacts(exit);
    this.#logger.error({ cmd: wrapper.command, exit: how, tail }, 'unexpected process exit');
    this.#unexpectedExit = { wrapper, exit };
    await this.#stopPipeline('process-exit');
    this.#ttlWatcher.stop();
  }

  async #onTtlExpired() {
    await this.#stopPipeline('ttl');
  }

  /**
   * Start (or replace) a stream for a YouTube URL. Throws on failure — the
   * HTTP layer maps that to a 500. No hidden retries.
   */
  async start(youtubeUrl) {
    if (this.#current && this.#current.phase === 'streaming' && this.#current.url === youtubeUrl) {
      return; // same URL already streaming
    }

    this.#lastUrl = youtubeUrl;

    const replacing = Boolean(this.#current);
    if (replacing) {
      await this.#stopPipeline('replaced');
      this.#ttlWatcher.stop();
    }

    try {
      await this.#icecast.prepareMountPoint();
      this.#unexpectedExit = null;
      this.#current = {
        url: youtubeUrl,
        phase: 'starting',
        startedAt: null
      };

      const streamlink = await this.#streamlink.spawnProcess(youtubeUrl);
      this.#logger.info({ proxy: streamlink.lastProxy }, 'starting streamlink');
      const ffmpeg = await this.#ffmpeg.spawnProcess(this.#icecast.sourceUrl);
      streamlink.pipe(ffmpeg);
      await this.#awaitStreamReadiness();

      this.#current.phase = 'streaming';
      this.#current.startedAt = Date.now();
      this.#ttlWatcher.watch(youtubeUrl);
      this.#events.emit(Event.streamStarted, { url: youtubeUrl });
    } catch (err) {
      this.#logger.error({ err: err.message }, 'failed to start stream');
      await this.#stopPipeline('start-failed');
      this.#ttlWatcher.stop();
      this.#current = null;
      this.#events.emit(Event.streamError, { url: youtubeUrl, error: err.message });
      throw err;
    }
  }

  async stop() {
    if (!this.#current) {
      return;
    }
    await this.#stopPipeline('manual');
    this.#ttlWatcher.stop();
  }

  /**
   * Waits for end-to-end readiness: the mountpoint active, failing fast when
   * a pipeline process dies (with its stderr tail) or the budget runs out.
   */
  async #awaitStreamReadiness() {
    const deadline = Date.now() + this.#mountpointTimeout;
    while (true) {
      const exit = this.#unexpectedExit;
      if (exit) {
        throw this.#exitError(exit);
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

  #exitError({ wrapper, exit }) {
    const { how, tail } = this.#exitFacts(exit);
    return new Error(
      `${wrapper.command} exited before the mountpoint became active (${how})${tail ? `: ${tail}` : ''}`
    );
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
   * process's liveness, Icecast availability/state, and the general stream
   * state + URL. Independent of the TTL watcher.
   */
  async getStatus() {
    const icecastStatus = await this.#icecast.getStatus();
    return {
      streamlink: { status: this.#streamlink.isAlive() ? 'running' : 'stopped' },
      ffmpeg: { status: this.#ffmpeg.isAlive() ? 'running' : 'stopped' },
      icecast: {
        status: icecastStatus.icecastReachable ? 'available' : 'unavailable',
        state: icecastStatus.mountpointActive ? 'streaming' : 'stopped'
      },
      general: {
        state: this.#current ? this.#current.phase : 'idle',
        url: this.#current?.url ?? this.#lastUrl ?? null
      }
    };
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

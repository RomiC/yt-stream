import { Streamlink } from './streamlink.js';
import { Ffmpeg } from './ffmpeg.js';
import { IcecastUnreachableError } from './icecastClient.js';
import { TTLWatcher } from './ttlWatcher.js';
import { describeExit } from './utils/describeExit.js';
import { redactProxy } from './utils/redactProxy.js';

const MOUNTPOINT_TIMEOUT = 30_000; // streamlink open + ffmpeg connecting to Icecast
const POLL_INTERVAL = 500;
const START_ATTEMPTS = 3; // each attempt re-picks the proxy
/**
 * One stream generation: owns a fresh streamlink/ffmpeg pair per start attempt,
 * the TTL watcher and the Icecast client, plus the url/startedAt identity.
 * Its phase is derived from process liveness and Icecast readiness, so it is
 * self-describing. It emits no events — Stream observes it via
 * onExit/onExpired. It logs only its per-attempt starts, through the shared logger.
 */
export class StreamPipeline {
  #id;
  #url;
  #startedAt;
  #streamlink = null;
  #ffmpeg = null;
  #ttlWatcher;
  #icecast;
  #streamlinkQuality;
  #proxies;
  #logger;
  #ready = false;
  #lastProxy = null;
  #exitCallbacks = [];
  #lastExit = null;

  constructor({ id, url, streamlinkQuality, proxies, streamTtlMinutes, icecast, logger }) {
    this.#id = id;
    this.#url = url;
    this.#startedAt = null;
    this.#streamlinkQuality = streamlinkQuality;
    this.#proxies = proxies;
    this.#logger = logger;
    this.#ttlWatcher = new TTLWatcher({ streamTtlMinutes, icecast });
    this.#icecast = icecast;
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
    if (!this.#streamlink?.isAlive() || !this.#ffmpeg?.isAlive()) {
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
   * `START_ATTEMPTS` attempts; each one re-picks the proxy (a poisoned exit
   * no longer burns the whole budget) and both processes are torn down
   * between attempts. Fails fast with attribution if a process dies or
   * Icecast drops; throws if the mount never becomes active within the budget.
   */
  async start(sourceUrl) {
    this.#ready = false;
    // Per-request rotation: created, consumed, and discarded within this start.
    const proxyRotation = this.#proxies.pickProxies();
    let lastError;
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
      try {
        await this.#startAttempt(sourceUrl, attempt, proxyRotation.next().value ?? null);
        this.#ready = true;
        this.#startedAt = Date.now();
        return;
      } catch (err) {
        lastError = err;
        await this.#killProcesses();
        if (attempt < START_ATTEMPTS) {
          // Wait for the IceCast mount point to be free from previous request
          await this.#icecast.prepareMountPoint();
        }
      }
    }
    throw lastError;
  }

  async #startAttempt(sourceUrl, attempt, proxy) {
    this.#lastExit = null;
    this.#lastProxy = proxy ? redactProxy(proxy) : null;
    this.#logger.info({ attempt, maxAttempts: START_ATTEMPTS, proxy: this.#lastProxy }, 'starting streamlink');
    // A fresh pair per attempt — a retry is a new pair, so a late exit of a
    // retired incarnation reports itself, not the current pair.
    this.#streamlink = new Streamlink({ streamlinkQuality: this.#streamlinkQuality })
      .onExit((exit) => this.#onWrapperExit(exit))
      .spawnProcess(this.#url, proxy);
    this.#ffmpeg = new Ffmpeg().onExit((exit) => this.#onWrapperExit(exit)).spawnProcess(sourceUrl);
    this.#streamlink.pipe(this.#ffmpeg);
    await this.#waitReady();
  }

  /** Kills the current pair (owner kills — their exits stay silent). */
  async #killProcesses() {
    await Promise.all([this.#streamlink?.kill() ?? false, this.#ffmpeg?.kill() ?? false]);
  }

  /** Idempotent stop: stops its watcher, then kills the current pair. */
  async stop() {
    this.#ttlWatcher.stop();
    await this.#killProcesses();
  }

  /** Liveness snapshot for /health. */
  getStatus() {
    return {
      streamlink: { status: this.#streamlink?.isAlive() ? 'running' : 'stopped' },
      ffmpeg: { status: this.#ffmpeg?.isAlive() ? 'running' : 'stopped' }
    };
  }

  async #waitReady() {
    const deadline = Date.now() + MOUNTPOINT_TIMEOUT;
    while (true) {
      if (!this.#streamlink?.isAlive() || !this.#ffmpeg?.isAlive()) {
        throw this.#exitError(this.#lastExit);
      }
      const status = await this.#icecast.getStatus();
      if (!status.icecastReachable) {
        throw new IcecastUnreachableError();
      }
      if (status.mountpointActive) {
        // A child may have exited while the status request was in flight.
        if (!this.#streamlink?.isAlive() || !this.#ffmpeg?.isAlive()) {
          throw this.#exitError(this.#lastExit);
        }
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('mountpoint never became active');
      }
      await sleep(Math.min(POLL_INTERVAL, deadline - Date.now()));
    }
  }

  #onWrapperExit(exit) {
    this.#lastExit = exit;
    for (const callback of this.#exitCallbacks) {
      callback(exit);
    }
  }

  #exitError(exit) {
    const { how, tail } = describeExit(exit);
    return new Error(`${exit.cmd} exited before the mountpoint became active (${how})${tail ? `: ${tail}` : ''}`);
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

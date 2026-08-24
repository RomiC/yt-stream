import { Event } from './events.js';

// TTL is configured in minutes, so a 60s poll granularity is plenty.
const TTL_POLL_INTERVAL_MS = 60_000;

/**
 * Enforces the zero-listener TTL by polling Icecast. Owns its own polling
 * loop: `watch()` starts it, and on expiry it emits `ttl:expired` and stops
 * itself. Icecast is a passive client — it knows nothing about TTL.
 */
export class TTLWatcher {
  #config;
  #logger;
  #events;
  #icecast;
  #timer = null;
  #url = null;
  #idleSince = null;

  constructor({ config, logger, events, icecast }) {
    this.#config = config;
    this.#logger = logger;
    this.#events = events;
    this.#icecast = icecast;
  }

  /**
   * Starts watching the stream at `url`. Idempotent; resets accumulated idle
   * time; no-op when TTL is disabled (streamTtlMinutes === 0).
   */
  watch(url) {
    this.stop();
    this.#url = url;
    if (this.#config.streamTtlMinutes === 0) {
      return;
    }
    const timer = setInterval(() => {
      this.#tick().catch((err) => this.#logger.error({ err: err.message }, 'ttl watcher error'));
    }, TTL_POLL_INTERVAL_MS);
    timer.unref();
    this.#timer = timer;
  }

  /** Stops watching (idempotent). */
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#idleSince = null;
  }

  async #tick() {
    const iceStatus = await this.#icecast.pollNow();
    if (!iceStatus.icecastReachable || iceStatus.listeners > 0) {
      this.#idleSince = null;
      return;
    }
    if (!this.#idleSince) {
      this.#idleSince = Date.now();
    } else if (Date.now() - this.#idleSince >= this.#config.streamTtlMinutes * 60_000) {
      this.#logger.info({ ttlMinutes: this.#config.streamTtlMinutes }, 'TTL expired');
      this.stop();
      this.#events.emit(Event.ttlExpired, { url: this.#url });
    }
  }
}

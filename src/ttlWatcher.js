// TTL is configured in minutes, so a 60s poll granularity is plenty.
const TTL_POLL_INTERVAL_MS = 60_000;

/**
 * Enforces the zero-listener TTL by polling Icecast. Owns its own polling
 * loop: `watch()` starts it, and on expiry it notifies its `onExpired`
 * subscribers and stops itself. Icecast is a passive client — it knows
 * nothing about TTL.
 */
export class TTLWatcher {
  #config;
  #logger;
  #icecast;
  #timer = null;
  #url = null;
  #idleSince = null;
  #expiredCallbacks = [];

  constructor({ config, logger, icecast }) {
    this.#config = config;
    this.#logger = logger;
    this.#icecast = icecast;
  }

  /** Subscribes to TTL expiry notifications ({ url }). */
  onExpired(callback) {
    this.#expiredCallbacks.push(callback);
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
    const iceStatus = await this.#icecast.getStatus();
    // Only confirmed listeners reset the idle timer; an unreachable Icecast
    // (admin, source and listeners share port 8000) means nobody can listen.
    if (iceStatus.listeners > 0) {
      this.#idleSince = null;
      return;
    }
    if (!this.#idleSince) {
      this.#idleSince = Date.now();
    } else if (Date.now() - this.#idleSince >= this.#config.streamTtlMinutes * 60_000) {
      this.#logger.info({ ttlMinutes: this.#config.streamTtlMinutes }, 'TTL expired');
      this.stop();
      const url = this.#url;
      for (const callback of this.#expiredCallbacks) {
        callback({ url });
      }
    }
  }
}

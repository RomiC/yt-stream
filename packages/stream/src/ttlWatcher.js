// TTL is configured in minutes, so a 60s poll granularity is plenty.
const TTL_POLL_INTERVAL_MS = 60_000;

/**
 * Enforces the zero-listener TTL by polling Icecast. Owns its own polling
 * loop: `watch()` starts it, and on expiry it notifies its `onExpired`
 * subscribers and stops itself. Icecast is a passive client — it knows
 * nothing about TTL.
 */
export class TTLWatcher {
  #streamTtlMinutes;
  #icecast;
  #timer = null;
  #url = null;
  #idleSince = null;
  #expiredCallbacks = [];

  constructor({ streamTtlMinutes, icecast }) {
    this.#streamTtlMinutes = streamTtlMinutes;
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
    if (this.#streamTtlMinutes === 0) {
      return;
    }
    const tick = (timer) => void this.#tick(timer);
    const timer = setInterval(() => tick(timer), TTL_POLL_INTERVAL_MS);
    timer.unref();
    this.#timer = timer;
    tick(timer); // prime the idle clock at watch() time, not at the first poll
  }

  /** Stops watching (idempotent). */
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#idleSince = null;
  }

  async #tick(timer) {
    const iceStatus = await this.#icecast.getStatus();

    // A poll from a previous watch must not touch the new idle state.
    if (this.#timer !== timer) {
      return;
    }
    // Only confirmed listeners reset the idle timer; an unreachable Icecast
    // (admin, source and listeners share port 8000) means nobody can listen.
    if (iceStatus.listeners > 0) {
      this.#idleSince = null;
      return;
    }
    if (this.#idleSince === null) {
      this.#idleSince = Date.now();
    } else if (Date.now() - this.#idleSince >= this.#streamTtlMinutes * 60_000) {
      this.stop();
      const url = this.#url;
      for (const callback of this.#expiredCallbacks) {
        callback({ url });
      }
    }
  }
}

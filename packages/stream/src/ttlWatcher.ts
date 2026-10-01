import type { IcecastProbe } from './status';

const TTL_POLL_INTERVAL_MS = 60_000;

export interface TTLWatcherOptions {
  streamTtlMinutes: number;
  icecast: { getStatus(): Promise<IcecastProbe> };
}

/**
 * Enforces the zero-listener TTL by polling Icecast. Owns its own polling
 * loop: `watch()` starts it, and on expiry it notifies its `onExpired`
 * subscribers and stops itself.
 */
export class TTLWatcher {
  #streamTtlMinutes: number;
  #icecast: { getStatus(): Promise<IcecastProbe> };
  #timer: ReturnType<typeof setInterval> | null = null;
  #url: string | null = null;
  #idleSince: number | null = null;
  #expiredCallbacks: ((payload: { url: string | null }) => void)[] = [];

  constructor({ streamTtlMinutes, icecast }: TTLWatcherOptions) {
    this.#streamTtlMinutes = streamTtlMinutes;
    this.#icecast = icecast;
  }

  onExpired(callback: (payload: { url: string | null }) => void): void {
    this.#expiredCallbacks.push(callback);
  }

  watch(url: string): void {
    this.stop();
    this.#url = url;
    if (this.#streamTtlMinutes === 0) {
      return;
    }
    const tick = (timer: ReturnType<typeof setInterval>): void => void this.#tick(timer);
    const timer = setInterval(() => tick(timer), TTL_POLL_INTERVAL_MS);
    timer.unref();
    this.#timer = timer;
    tick(timer); // prime the idle clock at watch() time, not at the first poll
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#idleSince = null;
  }

  async #tick(timer: ReturnType<typeof setInterval>): Promise<void> {
    const iceStatus = await this.#icecast.getStatus();

    // A poll from a previous watch must not touch the new idle state.
    if (this.#timer !== timer) {
      return;
    }
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

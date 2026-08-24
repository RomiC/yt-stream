const MOUNTPOINT = '/stream';
const MOUNTPOINT_TIMEOUT = 10_000; // ffmpeg spawning and connecting to Icecast (streamlink open is already verified)
const MOUNTPOINT_CLEAR_TIMEOUT = 10_000;
const WAIT_POLL_INTERVAL = 500;

export class IcecastUnreachableError extends Error {
  constructor() {
    super('Icecast unreachable — cannot start stream');
    this.name = 'IcecastUnreachableError';
  }
}

/**
 * Icecast admin client. Passive — it only polls when asked (pollNow) and
 * exposes the last result; the caller (Stream) owns any polling schedule.
 */
export class Icecast {
  #config;
  #logger;
  #mountpointTimeout;
  #mountpointClearTimeout;
  #waitPollInterval;
  #status = { icecastReachable: false, mountpointActive: false, listeners: 0 };

  constructor({ config, logger, timeouts = {} }) {
    this.#config = config;
    this.#logger = logger;
    this.#mountpointTimeout = timeouts.mountpointTimeout ?? MOUNTPOINT_TIMEOUT;
    this.#mountpointClearTimeout = timeouts.mountpointClearTimeout ?? MOUNTPOINT_CLEAR_TIMEOUT;
    this.#waitPollInterval = timeouts.waitPollInterval ?? WAIT_POLL_INTERVAL;
  }

  get #adminUrl() {
    return `http://${this.#config.icecast.host}:${this.#config.icecast.port}/admin/listmounts`;
  }

  get #authHeaders() {
    return {
      Authorization: `Basic ${Buffer.from(`admin:${this.#config.icecast.adminPassword}`).toString('base64')}`
    };
  }

  /** Source URL ffmpeg pushes audio to. */
  get sourceUrl() {
    return `icecast://source:${this.#config.icecast.sourcePassword}@${this.#config.icecast.host}:${this.#config.icecast.port}/stream`;
  }

  #parseListeners(xml) {
    // Icecast admin XML is simple and stable — regex is sufficient.
    const mountRegex = new RegExp(`<source\\s[^>]*mount="${MOUNTPOINT}"[^>]*>([\\s\\S]*?)</source>`, 'i');
    const mountMatch = xml.match(mountRegex);
    if (!mountMatch) {
      return { mountpointActive: false, listeners: 0 };
    }

    const listenersMatch = mountMatch[1].match(/<listeners>(\d+)<\/listeners>/i);
    return {
      mountpointActive: true,
      listeners: listenersMatch ? parseInt(listenersMatch[1], 10) : 0
    };
  }

  async #poll() {
    try {
      const res = await fetch(this.#adminUrl, { headers: this.#authHeaders });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const parsed = this.#parseListeners(await res.text());
      this.#status = { icecastReachable: true, ...parsed };
    } catch (err) {
      this.#status = { icecastReachable: false, mountpointActive: false, listeners: 0 };
      this.#logger.warn({ err: err.message }, 'icecast poll failed');
    }
  }

  getStatus() {
    return { ...this.#status };
  }

  /** Public audio mount URL the client is redirected to after a successful start. */
  get streamUrl() {
    return `http://${this.#config.publicHostname}:${this.#config.icecast.publicPort}/stream`;
  }

  async pollNow() {
    await this.#poll();
    return { ...this.#status };
  }

  /**
   * Pre-spawn readiness: confirms Icecast is reachable and that the mount is
   * free (any old source has released it). On a clean start the mount is
   * already inactive, so this returns immediately; after a stop/replace it
   * ensures no stale source is mistaken for the new one by waitForMountpoint.
   * A release timeout is a warning, not a failure — the post-spawn check
   * will surface a genuinely stuck source.
   */
  /**
   * Pre-spawn readiness: confirms Icecast is reachable and that the mount is
   * free (any old source has released it). On a clean start the mount is
   * already inactive, so this returns immediately; after a stop/replace it
   * ensures no stale source is mistaken for the new one by waitForMountpoint.
   * Icecast refuses a second source on a taken mount, so a release timeout
   * fails the start — there is nothing to gain by proceeding.
   */
  async prepareMountPoint() {
    try {
      await this.#waitForMountState(false, this.#mountpointClearTimeout);
    } catch (err) {
      if (err instanceof IcecastUnreachableError) {
        throw err;
      }
      throw new Error('old source still connected to the mountpoint — cannot start a new stream');
    }
  }

  /**
   * Post-spawn confirmation: waits until the mountpoint is active, i.e. our
   * source is actually connected. Fails fast with IcecastUnreachableError if
   * Icecast drops mid-wait.
   */
  async waitForMountpoint() {
    await this.#waitForMountState(true, this.#mountpointTimeout);
  }

  async #waitForMountState(active, timeoutMs) {
    // Confirm Icecast is reachable (and not already in the target state)
    // before starting to poll for it.
    const initial = await this.pollNow();
    if (!initial.icecastReachable) {
      throw new IcecastUnreachableError();
    }
    if (initial.mountpointActive === active) {
      return;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.pollNow();
      if (!status.icecastReachable) {
        // Fail fast — polling a dead Icecast until the deadline would only
        // produce a misleading 'mountpoint never became active'.
        throw new IcecastUnreachableError();
      }
      if (status.mountpointActive === active) {
        return;
      }
      // Never sleep past the deadline — the wait's own outcome always wins
      // over any external timeout.
      await sleep(Math.min(this.#waitPollInterval, deadline - Date.now()));
    }
    throw new Error(active ? 'mountpoint never became active' : 'mountpoint never released');
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

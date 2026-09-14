const MOUNTPOINT = '/stream';
const MOUNTPOINT_CLEAR_TIMEOUT = 10_000;
const WAIT_POLL_INTERVAL = 500;

export class IcecastUnreachableError extends Error {
  constructor() {
    super('Icecast unreachable — cannot start stream');
    this.name = 'IcecastUnreachableError';
  }
}

/**
 * Icecast admin client. Passive — it only fetches when asked (getStatus)
 * and knows nothing about polling schedules; the caller (Stream) owns them.
 */
export class Icecast {
  #host;
  #port;
  #sourcePassword;
  #adminPassword;
  #publicBaseUrl;
  #logger;
  #mountpointClearTimeout;
  #waitPollInterval;

  constructor({ host, port, sourcePassword, adminPassword, publicBaseUrl, logger, timeouts = {} }) {
    this.#host = host;
    this.#port = port;
    this.#sourcePassword = sourcePassword;
    this.#adminPassword = adminPassword;
    this.#publicBaseUrl = publicBaseUrl;
    this.#logger = logger;
    this.#mountpointClearTimeout = timeouts.mountpointClearTimeout ?? MOUNTPOINT_CLEAR_TIMEOUT;
    this.#waitPollInterval = timeouts.waitPollInterval ?? WAIT_POLL_INTERVAL;
  }

  get #adminUrl() {
    return `http://${this.#host}:${this.#port}/admin`;
  }

  get #listmountsUrl() {
    return `${this.#adminUrl}/listmounts`;
  }

  get #metadataUrl() {
    return `${this.#adminUrl}/metadata`;
  }

  get #authHeaders() {
    return {
      Authorization: `Basic ${Buffer.from(`admin:${this.#adminPassword}`).toString('base64')}`
    };
  }

  /** Source URL ffmpeg pushes audio to. */
  get sourceUrl() {
    return `icecast://source:${this.#sourcePassword}@${this.#host}:${this.#port}/stream`;
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

  /**
   * Fetches and returns the current Icecast status: reachability, whether
   * the mountpoint is active, and the listener count. Never throws — an
   * unreachable Icecast is a status like any other.
   */
  async getStatus() {
    try {
      const res = await fetch(this.#listmountsUrl, { headers: this.#authHeaders, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return { icecastReachable: true, ...this.#parseListeners(await res.text()) };
    } catch (err) {
      this.#logger.warn({ err: err.message }, 'icecast poll failed');
      return { icecastReachable: false, mountpointActive: false, listeners: 0 };
    }
  }

  /** Public audio mount URL, built from PUBLIC_BASE_URL (served via Caddy). */
  get streamUrl() {
    return `${this.#publicBaseUrl.replace(/\/+$/, '')}/stream`;
  }

  /**
   * Pre-spawn readiness: confirms Icecast is reachable and that the mount is
   * free (any old source has released it). On a clean start the mount is
   * already inactive, so this returns immediately; after a stop/replace it
   * ensures no stale source is mistaken for the new pipeline's source.
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

  async #waitForMountState(active, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const status = await this.getStatus();
      if (!status.icecastReachable) {
        throw new IcecastUnreachableError();
      }
      if (status.mountpointActive === active) {
        return;
      }
      if (Date.now() >= deadline) {
        break;
      }
      // Never sleep past the deadline — the wait's own outcome always wins
      // over any external timeout.
      await sleep(Math.min(this.#waitPollInterval, deadline - Date.now()));
    }
    throw new Error(active ? 'mountpoint never became active' : 'mountpoint never released');
  }

  async setMetadata(title) {
    try {
      const params = new URLSearchParams({
        mount: MOUNTPOINT,
        mode: 'updinfo',
        song: title.replace(/[^\x20-\x7E]/g, '')
      });

      const res = await fetch(`${this.#metadataUrl}?${params.toString()}`, {
        headers: this.#authHeaders,
        signal: AbortSignal.timeout(5_000)
      });

      return res.ok;
    } catch {
      return false;
    }
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

import type { Logger } from 'yt-stream-shared';
import type { IcecastProbe } from './status';

const MOUNTPOINT = '/stream';
const MOUNTPOINT_CLEAR_TIMEOUT = 10_000;
const WAIT_POLL_INTERVAL = 500;

export class IcecastUnreachableError extends Error {
  constructor() {
    super('Icecast unreachable — cannot start stream');
    this.name = 'IcecastUnreachableError';
  }
}

export interface IcecastClientOptions {
  host: string;
  port: number;
  sourcePassword: string;
  adminPassword: string;
  publicBaseUrl: string;
  logger: Logger;
  timeouts?: {
    mountpointClearTimeout?: number;
    waitPollInterval?: number;
  };
}

/**
 * Icecast admin client. Passive — it only fetches when asked (getStatus)
 * and knows nothing about polling schedules; the caller owns them.
 */
export class IcecastClient {
  #host: string;
  #port: number;
  #sourcePassword: string;
  #adminPassword: string;
  #publicBaseUrl: string;
  #logger: Logger;
  #mountpointClearTimeout: number;
  #waitPollInterval: number;

  constructor({
    host,
    port,
    sourcePassword,
    adminPassword,
    publicBaseUrl,
    logger,
    timeouts = {}
  }: IcecastClientOptions) {
    this.#host = host;
    this.#port = port;
    this.#sourcePassword = sourcePassword;
    this.#adminPassword = adminPassword;
    this.#publicBaseUrl = publicBaseUrl;
    this.#logger = logger;
    this.#mountpointClearTimeout = timeouts.mountpointClearTimeout ?? MOUNTPOINT_CLEAR_TIMEOUT;
    this.#waitPollInterval = timeouts.waitPollInterval ?? WAIT_POLL_INTERVAL;
  }

  get #adminUrl(): string {
    return `http://${this.#host}:${this.#port}/admin`;
  }

  get #listmountsUrl(): string {
    return `${this.#adminUrl}/listmounts`;
  }

  get #metadataUrl(): string {
    return `${this.#adminUrl}/metadata`;
  }

  get #authHeaders(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`admin:${this.#adminPassword}`).toString('base64')}`
    };
  }

  get sourceUrl(): string {
    return `icecast://source:${this.#sourcePassword}@${this.#host}:${this.#port}/stream`;
  }

  get streamUrl(): string {
    return `${this.#publicBaseUrl.replace(/\/+$/, '')}/stream`;
  }

  async getStatus(): Promise<IcecastProbe> {
    try {
      const res = await fetch(this.#listmountsUrl, {
        headers: this.#authHeaders,
        signal: AbortSignal.timeout(5_000)
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return {
        icecastReachable: true,
        ...this.#parseListeners(await res.text())
      };
    } catch (err) {
      this.#logger.warn({ err: (err as Error).message }, 'icecast poll failed');
      return { icecastReachable: false, mountpointActive: false, listeners: 0 };
    }
  }

  async prepareMountPoint(): Promise<void> {
    try {
      await this.#waitForMountState(false, this.#mountpointClearTimeout);
    } catch (err) {
      if (err instanceof IcecastUnreachableError) {
        throw err;
      }
      throw new Error('old source still connected to the mountpoint — cannot start a new stream');
    }
  }

  async setMetadata(title: string): Promise<boolean> {
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

  #parseListeners(xml: string): { mountpointActive: boolean; listeners: number } {
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

  async #waitForMountState(active: boolean, timeoutMs: number): Promise<void> {
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
      await sleep(Math.min(this.#waitPollInterval, deadline - Date.now()));
    }
    throw new Error(active ? 'mountpoint never became active' : 'mountpoint never released');
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

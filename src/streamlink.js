import { ChildProcess } from './childProcess.js';

function redactProxy(proxy) {
  try {
    const url = new URL(proxy);
    // Redact when either a username or a password is present (a password-only
    // URL, e.g. http://:pass@host:port, has an empty username but must still
    // be stripped before logging).
    return url.username || url.password ? `${url.protocol}//${url.host}` : proxy;
  } catch {
    return proxy;
  }
}

/**
 * Owns the streamlink child process: fetches the YouTube stream (optionally
 * through a proxy from config.proxyList) and writes raw media to stdout,
 * which is piped into ffmpeg's stdin. One process at a time;
 * spawnProcess replaces any previous process.
 */
export class Streamlink extends ChildProcess {
  #streamlinkQuality;
  #proxyList;
  #lastProxy = null;

  constructor({ streamlinkQuality, proxyList = [] } = {}) {
    super({ cmd: 'streamlink' });
    this.#streamlinkQuality = streamlinkQuality;
    this.#proxyList = proxyList;
  }

  /** Last picked proxy, already redacted for logging. */
  get lastProxy() {
    return this.#lastProxy;
  }

  /** Picks a random proxy from the configured list, or null when none. */
  #pickProxy() {
    return this.#proxyList.length > 0 ? this.#proxyList[Math.floor(Math.random() * this.#proxyList.length)] : null;
  }

  /** Spawns streamlink, through a random configured proxy when present. */
  async spawnProcess(youtubeUrl) {
    const proxy = this.#pickProxy();
    this.#lastProxy = proxy ? redactProxy(proxy) : null;
    const args = ['--default-stream', this.#streamlinkQuality, '--retry-open', '3', '--output', '-'];
    if (proxy) {
      args.push('--http-proxy', proxy);
    }
    args.push(youtubeUrl);

    await this.spawn(args, ['ignore', 'pipe', 'pipe']);
    return this;
  }
}

import { ChildProcess } from './childProcess.js';

const STREAMLINK_OPEN_TIMEOUT = 30_000;

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
  #config;
  #openTimeout;

  constructor({ config, logger, events, sigkillDelayMs, openTimeout = STREAMLINK_OPEN_TIMEOUT }) {
    super({ cmd: 'streamlink', logger, events, sigkillDelayMs });
    this.#config = config;
    this.#openTimeout = openTimeout;
  }

  /** Picks a random proxy from the configured list, or null when none. */
  #pickProxy() {
    const proxies = this.#config.proxyList;
    return proxies.length > 0 ? proxies[Math.floor(Math.random() * proxies.length)] : null;
  }

  /**
   * Spawns streamlink and waits until it has actually opened the stream
   * (first bytes on stdout), so a bad URL / failed extraction fails this
   * call instead of surfacing later as a silent dead pipeline.
   */
  async spawnProcess(youtubeUrl) {
    const proxy = this.#pickProxy();
    this.getLogger().info({ proxy: proxy ? redactProxy(proxy) : null }, 'starting streamlink');
    const args = ['--default-stream', this.#config.streamlinkQuality, '--retry-open', '3', '--output', '-'];
    if (proxy) {
      args.push('--http-proxy', proxy);
    }
    args.push(youtubeUrl);

    await this.spawn(args, ['ignore', 'pipe', 'pipe']);
    await this.#waitForStreamOpened();
    return this;
  }

  async #waitForStreamOpened() {
    const proc = this.getProcess();
    if (!proc?.stdout) {
      return;
    }

    let timer;
    const opened = new Promise((resolve) => proc.stdout.once('data', resolve));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('streamlink did not produce output')), this.#openTimeout);
    });
    try {
      await Promise.race([opened, timeout]);
    } catch {
      const tail = this.getErrorTail();
      throw new Error(`streamlink did not open the stream${tail ? `: ${tail.split('\n').slice(-3).join(' | ')}` : ''}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

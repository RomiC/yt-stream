import { readFileSync } from 'node:fs';

const PROXY_SCHEMES = ['http:', 'https:', 'socks5:', 'socks5h:'];

function isValidProxyUrl(proxy) {
  try {
    const url = new URL(proxy);
    return PROXY_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
}

/** Fisher–Yates copy — unbiased, unlike a random sort comparator. */
function shuffle(entries) {
  const pool = [...entries];
  for (let index = pool.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool;
}

/**
 * Parses proxy-list file content: a JSON array of proxy URL strings
 * (`http(s)`, `socks5`, `socks5h`). Invalid entries are dropped; duplicates
 * collapse so repeated entries cannot bias the rotation. Order is preserved.
 */
function parseProxyList(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const valid = parsed.filter((proxy) => typeof proxy === 'string' && proxy.trim() !== '' && isValidProxyUrl(proxy));
  return [...new Set(valid)];
}

/**
 * Proxy list implementation to load and pick proxy for the next streamlink request
 */
export class ProxyList {
  #proxies;

  /**
   * @param {string} proxyFile - path to the JSON array of proxy URLs
   * @param {{warn: (message: string) => void}} logger - degraded-load warnings land here
   */
  constructor(proxyFile, logger) {
    this.#proxies = this.#load(proxyFile, logger);
  }

  /** Frozen snapshot of the loaded pool; empty when the file is absent or unusable. */
  get proxies() {
    return Object.freeze([...this.#proxies]);
  }

  /**
   * Returns a fresh per-request rotation over the pool.
   * @returns {Generator<string|null>} pull per attempt; null on the first pull means an empty pool (direct connection)
   */
  *pickProxies() {
    if (this.#proxies.length === 0) {
      yield null;
      return;
    }

    while (true) {
      for (const proxy of shuffle(this.#proxies)) {
        yield proxy;
      }
    }
  }

  #load(proxyFile, logger) {
    let text;
    try {
      text = readFileSync(proxyFile, 'utf-8');
    } catch (err) {
      logger.warn(`${this.#readFailure(proxyFile, err)} — no proxies loaded, streamlink connects directly`);
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn(`${proxyFile} is not valid JSON — no proxies loaded, streamlink connects directly`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      logger.warn(
        `${proxyFile} must contain a JSON array of proxy URLs — no proxies loaded, streamlink connects directly`
      );
      return [];
    }

    const proxies = parseProxyList(text);
    if (parsed.length > 0 && proxies.length === 0) {
      logger.warn(`${proxyFile} contains no valid proxy URLs — no proxies loaded, streamlink connects directly`);
    }
    return proxies;
  }

  #readFailure(path, err) {
    if (err.code === 'EISDIR') {
      return `${path} is a directory, not a proxy list file — remove it and create the file (cp proxy.json.example proxy.json)`;
    }
    return err.code === 'ENOENT' ? `${path} not found` : `${path} is not readable (${err.code})`;
  }
}

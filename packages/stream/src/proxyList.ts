import { readFileSync } from 'node:fs';

const PROXY_SCHEMES = ['http:', 'https:', 'socks5:', 'socks5h:'];

export interface WarnLogger {
  warn(message: string): void;
}

function isValidProxyUrl(proxy: string): boolean {
  try {
    const url = new URL(proxy);
    return PROXY_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
}

function shuffle(entries: string[]): string[] {
  const pool = [...entries];
  for (let index = pool.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool;
}

function parseProxyList(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const valid = parsed.filter(
    (proxy): proxy is string => typeof proxy === 'string' && proxy.trim() !== '' && isValidProxyUrl(proxy)
  );
  return [...new Set(valid)];
}

export class ProxyList {
  #proxies: string[];

  constructor(proxyFile: string, logger: WarnLogger) {
    this.#proxies = this.#load(proxyFile, logger);
  }

  get proxies(): string[] {
    return Object.freeze([...this.#proxies]) as string[];
  }

  *pickProxies(): Generator<string | null> {
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

  #load(proxyFile: string, logger: WarnLogger): string[] {
    let text: string;
    try {
      text = readFileSync(proxyFile, 'utf-8');
    } catch (err) {
      logger.warn(`${this.#readFailure(proxyFile, err)} — no proxies loaded, streamlink connects directly`);
      return [];
    }

    let parsed: unknown;
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

  #readFailure(path: string, err: unknown): string {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EISDIR') {
      return `${path} is a directory, not a proxy list file — remove it and create the file (cp proxy.json.example proxy.json)`;
    }
    return code === 'ENOENT' ? `${path} not found` : `${path} is not readable (${code})`;
  }
}

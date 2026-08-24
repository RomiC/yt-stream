import { readFileSync } from 'node:fs';

function parseIntEnv(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function isValidProxyUrl(proxy) {
  try {
    const url = new URL(proxy);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Immutable configuration built from an environment. `new Config()` reads
 * process.env; tests pass a synthetic env object.
 */
export class Config {
  #port;
  #icecast;
  #publicHostname;
  #logLevel;
  #streamTtlMinutes;
  #proxyList;
  #streamlinkQuality;

  constructor(env = process.env) {
    this.#port = parseIntEnv(env.PORT, 8080);
    this.#icecast = Object.freeze({
      host: env.ICECAST_HOST || 'icecast',
      port: 8000, // internal container port — never changes
      sourcePassword: env.ICECAST_SOURCE_PASSWORD || 'secret',
      adminPassword: env.ICECAST_ADMIN_PASSWORD || 'admin',
      publicPort: parseIntEnv(env.ICECAST_PORT, 8000) // host-facing port for redirects
    });
    this.#publicHostname = env.PUBLIC_HOSTNAME || 'localhost';
    this.#logLevel = env.LOG_LEVEL || 'info';
    this.#streamTtlMinutes = parseIntEnv(env.STREAM_TTL_MINUTES, 15);
    this.#proxyList = this.#loadProxyList(env.PROXY_FILE);
    this.#streamlinkQuality = env.STREAMLINK_QUALITY || 'audio_only,worst';
  }

  /** Reads the PROXY_FILE (a JSON array of proxy URL strings) once at startup. */
  #loadProxyList(proxyFile) {
    if (!proxyFile) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(proxyFile, 'utf-8'));
      return Array.isArray(parsed)
        ? parsed.filter((proxy) => typeof proxy === 'string' && proxy.trim() !== '' && isValidProxyUrl(proxy))
        : [];
    } catch {
      return [];
    }
  }

  get port() {
    return this.#port;
  }

  get icecast() {
    return this.#icecast;
  }

  get publicHostname() {
    return this.#publicHostname;
  }

  get logLevel() {
    return this.#logLevel;
  }

  get streamTtlMinutes() {
    return this.#streamTtlMinutes;
  }

  /** Valid proxy URLs, e.g. ['http://user:pass@1.12.2.2:8883']; empty when unset. */
  get proxyList() {
    return this.#proxyList;
  }

  get streamlinkQuality() {
    return this.#streamlinkQuality;
  }
}

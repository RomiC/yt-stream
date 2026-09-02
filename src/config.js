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
  #publicBaseUrl;
  #logLevel;
  #streamTtlMinutes;
  #proxyList;
  #streamlinkQuality;
  #apiKey;
  #allowKeyInQuery;

  constructor(env = process.env) {
    this.#port = parseIntEnv(env.PORT, 8080);
    this.#icecast = Object.freeze({
      host: env.ICECAST_HOST || 'icecast',
      port: 8000, // internal container port — never changes
      sourcePassword: env.ICECAST_SOURCE_PASSWORD || 'secret',
      adminPassword: env.ICECAST_ADMIN_PASSWORD || 'admin'
    });
    this.#publicBaseUrl = this.#normalizeBaseUrl(env.PUBLIC_BASE_URL || 'http://localhost');
    this.#logLevel = env.LOG_LEVEL || 'info';
    this.#streamTtlMinutes = parseIntEnv(env.STREAM_TTL_MINUTES, 15);
    this.#proxyList = this.#loadProxyList(env.PROXY_FILE);
    this.#streamlinkQuality = env.STREAMLINK_QUALITY || 'audio_only,worst';
    this.#apiKey = env.API_KEY || 'dev-api-key';
    this.#allowKeyInQuery = env.ALLOW_KEY_IN_QUERY === 'true';
  }

  /** Strips a trailing slash so callers can append paths directly. */
  #normalizeBaseUrl(value) {
    return value.replace(/\/+$/, '');
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

  get publicBaseUrl() {
    return this.#publicBaseUrl;
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

  get apiKey() {
    return this.#apiKey;
  }

  get allowKeyInQuery() {
    return this.#allowKeyInQuery;
  }
}

function parseIntEnv(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Immutable configuration built from an environment. `new Config()` reads
 * process.env; tests pass a synthetic env object.
 */
export class Config {
  #health;
  #caddyHealth;
  #stream;
  #icecast;
  #publicBaseUrl;
  #logLevel;
  #streamTtlMinutes;
  #proxyFile;
  #streamlinkQuality;
  #apiKey;
  #allowKeyInQuery;

  constructor(env = process.env) {
    this.#health = Object.freeze({
      host: 'health',
      port: 8080
    });
    this.#caddyHealth = Object.freeze({
      host: 'caddy',
      port: 8089
    });
    this.#stream = Object.freeze({
      host: 'stream',
      port: 8080
    });
    this.#icecast = Object.freeze({
      host: 'icecast',
      port: 8080,
      sourcePassword: env.ICECAST_SOURCE_PASSWORD || 'secret',
      adminPassword: env.ICECAST_ADMIN_PASSWORD || 'admin'
    });
    this.#publicBaseUrl = this.#normalizeBaseUrl(env.PUBLIC_BASE_URL || 'http://localhost');
    this.#logLevel = env.LOG_LEVEL || 'info';
    this.#streamTtlMinutes = parseIntEnv(env.STREAM_TTL_MINUTES, 15);
    this.#proxyFile = '/app/proxy.json'; // fixed: the compose bind-mount target
    this.#streamlinkQuality = env.STREAMLINK_QUALITY || 'audio_only,worst';
    this.#apiKey = env.API_KEY || 'dev-api-key';
    this.#allowKeyInQuery = env.ALLOW_KEY_IN_QUERY === 'true';
  }

  /**
   * Strips a trailing slash so callers can append paths directly.
   * @param {string} value - URL to normalize
   * @returns {string} Normalized URL w/o ending /
   */
  #normalizeBaseUrl(value) {
    let normalizedUrl = value;

    while (normalizedUrl.endsWith('/')) {
      normalizedUrl = normalizedUrl.slice(0, -1);
    }

    return normalizedUrl;
  }

  /** Path to the optional proxy list inside the stream container (compose bind-mount target). */
  get proxyFile() {
    return this.#proxyFile;
  }

  get health() {
    return this.#health;
  }

  get caddyHealth() {
    return this.#caddyHealth;
  }

  get stream() {
    return this.#stream;
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

export type ConfigEnv = Record<string, string | undefined>;

export interface HostPort {
  host: string;
  port: number;
}

export interface IcecastConfig extends HostPort {
  sourcePassword: string;
  adminPassword: string;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export class Config {
  #health: HostPort;
  #caddyHealth: HostPort;
  #stream: HostPort;
  #icecast: IcecastConfig;
  #publicBaseUrl: string;
  #logLevel: string;
  #streamTtlMinutes: number;
  #proxyFile: string;
  #streamlinkQuality: string;
  #apiKey: string;
  #allowKeyInQuery: boolean;

  constructor(env: ConfigEnv = process.env) {
    this.#health = Object.freeze({ host: 'health', port: 8080 });
    this.#caddyHealth = Object.freeze({ host: 'caddy', port: 8089 });
    this.#stream = Object.freeze({ host: 'stream', port: 8080 });
    this.#icecast = Object.freeze({
      host: 'icecast',
      port: 8080,
      sourcePassword: env.ICECAST_SOURCE_PASSWORD || 'secret',
      adminPassword: env.ICECAST_ADMIN_PASSWORD || 'admin'
    });
    this.#publicBaseUrl = this.#normalizeBaseUrl(env.PUBLIC_BASE_URL || 'http://localhost');
    this.#logLevel = env.LOG_LEVEL || 'info';
    this.#streamTtlMinutes = parseIntEnv(env.STREAM_TTL_MINUTES, 15);
    this.#proxyFile = '/app/proxy.json';
    this.#streamlinkQuality = env.STREAMLINK_QUALITY || 'audio_only,worst';
    this.#apiKey = env.API_KEY || 'dev-api-key';
    this.#allowKeyInQuery = env.ALLOW_KEY_IN_QUERY === 'true';
  }

  #normalizeBaseUrl(value: string): string {
    let normalizedUrl = value;

    while (normalizedUrl.endsWith('/')) {
      normalizedUrl = normalizedUrl.slice(0, -1);
    }

    return normalizedUrl;
  }

  get proxyFile(): string {
    return this.#proxyFile;
  }

  get health(): HostPort {
    return this.#health;
  }

  get caddyHealth(): HostPort {
    return this.#caddyHealth;
  }

  get stream(): HostPort {
    return this.#stream;
  }

  get icecast(): IcecastConfig {
    return this.#icecast;
  }

  get publicBaseUrl(): string {
    return this.#publicBaseUrl;
  }

  get logLevel(): string {
    return this.#logLevel;
  }

  get streamTtlMinutes(): number {
    return this.#streamTtlMinutes;
  }

  get streamlinkQuality(): string {
    return this.#streamlinkQuality;
  }

  get apiKey(): string {
    return this.#apiKey;
  }

  get allowKeyInQuery(): boolean {
    return this.#allowKeyInQuery;
  }
}

import { describe, expect, test } from 'bun:test';
import { Config } from '../../lib/config';

describe('Config', () => {
  test('applies defaults when env is empty', () => {
    const config = new Config({});

    expect(config.health.host).toBe('health');
    expect(config.health.port).toBe(8080);
    expect(config.caddyHealth.host).toBe('caddy');
    expect(config.caddyHealth.port).toBe(8089);
    expect(config.stream.host).toBe('stream');
    expect(config.stream.port).toBe(8080);
    expect(config.icecast.host).toBe('icecast');
    expect(config.icecast.port).toBe(8080);
    expect(config.icecast.sourcePassword).toBe('secret');
    expect(config.icecast.adminPassword).toBe('admin');
    expect(config.publicBaseUrl).toBe('http://localhost');
    expect(config.logLevel).toBe('info');
    expect(config.streamTtlMinutes).toBe(15);
    expect(config.proxyFile).toBe('/app/proxy.json');
    expect(config.streamlinkQuality).toBe('audio_only,worst');
    expect(config.apiKey).toBe('dev-api-key');
    expect(config.allowKeyInQuery).toBe(false);
  });

  test('parses env overrides', () => {
    const config = new Config({
      ICECAST_SOURCE_PASSWORD: 'icecast-source-password',
      ICECAST_ADMIN_PASSWORD: 'icecast-admin-password',
      PUBLIC_BASE_URL: 'https://yts.example.com:3001',
      LOG_LEVEL: 'debug',
      STREAM_TTL_MINUTES: '0',
      STREAMLINK_QUALITY: 'best',
      API_KEY: 'real-production-key',
      ALLOW_KEY_IN_QUERY: 'true'
    });

    // Caddy health, stream and icecast hosts and ports are hardcoded
    expect(config.caddyHealth.host).toBe('caddy');
    expect(config.caddyHealth.port).toBe(8089);
    expect(config.stream.host).toBe('stream');
    expect(config.stream.port).toBe(8080);
    expect(config.icecast.host).toBe('icecast');
    expect(config.icecast.port).toBe(8080);
    expect(config.icecast.sourcePassword).toBe('icecast-source-password');
    expect(config.icecast.adminPassword).toBe('icecast-admin-password');
    expect(config.publicBaseUrl).toBe('https://yts.example.com:3001');
    expect(config.logLevel).toBe('debug');
    expect(config.streamTtlMinutes).toBe(0);
    expect(config.streamlinkQuality).toBe('best');
    expect(config.apiKey).toBe('real-production-key');
    expect(config.allowKeyInQuery).toBe(true);
  });

  test('ALLOW_KEY_IN_QUERY is enabled only by the exact string "true"', () => {
    for (const value of ['false', 'yes', '1', 'TRUE', '']) {
      const config = new Config({ ALLOW_KEY_IN_QUERY: value });
      expect(config.allowKeyInQuery).toBe(false);
    }
  });

  test('falls back to defaults when numeric env vars are not parseable', () => {
    const config = new Config({
      STREAM_TTL_MINUTES: 'lots'
    });

    expect(config.streamTtlMinutes).toBe(15);
  });

  test('config is immutable', () => {
    const config = new Config({});
    expect(() => {
      config.stream.port = 1;
    }).toThrow(TypeError);
    expect(() => {
      config.icecast.host = 'x';
    }).toThrow(TypeError);
  });
});

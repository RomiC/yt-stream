import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../../lib/config.js';

describe('Config', () => {
  test('applies defaults when env is empty', () => {
    const config = new Config({});

    assert.equal(config.health.host, 'health');
    assert.equal(config.health.port, 8080);
    assert.equal(config.caddyHealth.host, 'caddy');
    assert.equal(config.caddyHealth.port, 8089);
    assert.equal(config.stream.host, 'stream');
    assert.equal(config.stream.port, 8080);
    assert.equal(config.icecast.host, 'icecast');
    assert.equal(config.icecast.port, 8080);
    assert.equal(config.icecast.sourcePassword, 'secret');
    assert.equal(config.icecast.adminPassword, 'admin');
    assert.equal(config.publicBaseUrl, 'http://localhost');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.streamTtlMinutes, 15);
    assert.equal(config.proxyFile, '/app/proxy.json');
    assert.equal(config.streamlinkQuality, 'audio_only,worst');
    assert.equal(config.apiKey, 'dev-api-key');
    assert.equal(config.allowKeyInQuery, false);
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
    assert.equal(config.caddyHealth.host, 'caddy');
    assert.equal(config.caddyHealth.port, 8089);
    assert.equal(config.stream.host, 'stream');
    assert.equal(config.stream.port, 8080);
    assert.equal(config.icecast.host, 'icecast');
    assert.equal(config.icecast.port, 8080);
    assert.equal(config.icecast.sourcePassword, 'icecast-source-password');
    assert.equal(config.icecast.adminPassword, 'icecast-admin-password');
    assert.equal(config.publicBaseUrl, 'https://yts.example.com:3001');
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.streamTtlMinutes, 0);
    assert.equal(config.streamlinkQuality, 'best');
    assert.equal(config.apiKey, 'real-production-key');
    assert.equal(config.allowKeyInQuery, true);
  });

  test('ALLOW_KEY_IN_QUERY is enabled only by the exact string "true"', () => {
    for (const value of ['false', 'yes', '1', 'TRUE', '']) {
      const config = new Config({ ALLOW_KEY_IN_QUERY: value });
      assert.equal(config.allowKeyInQuery, false, `ALLOW_KEY_IN_QUERY=${value}`);
    }
  });

  test('falls back to defaults when numeric env vars are not parseable', () => {
    const config = new Config({
      STREAM_TTL_MINUTES: 'lots'
    });

    assert.equal(config.streamTtlMinutes, 15);
  });

  test('config is immutable', () => {
    const config = new Config({});
    assert.throws(() => {
      // @ts-ignore
      config.stream.port = 1;
    }, TypeError);
    assert.throws(() => {
      // @ts-ignore
      config.icecast.host = 'x';
    }, TypeError);
  });
});

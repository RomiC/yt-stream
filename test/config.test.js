import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/config.js';

describe('Config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'yt-stream-config-'));
  after(() => rmSync(tempDir, { recursive: true, force: true }));

  function writeProxyFile(name, proxies) {
    const path = join(tempDir, name);
    writeFileSync(path, JSON.stringify(proxies));
    return path;
  }

  test('applies defaults when env is empty', () => {
    const config = new Config({});
    assert.equal(config.port, 8080);
    assert.equal(config.icecast.host, 'icecast');
    assert.equal(config.icecast.port, 8000);
    assert.equal(config.icecast.sourcePassword, 'secret');
    assert.equal(config.icecast.adminPassword, 'admin');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.streamTtlMinutes, 15);
    assert.deepEqual(config.proxyList, []);
    assert.equal(config.streamlinkQuality, 'audio_only,worst');
  });

  test('parses env overrides', () => {
    const proxyFile = writeProxyFile('proxies.json', ['http://user:pass@1.2.3.4:8883']);
    const config = new Config({
      PORT: '9000',
      ICECAST_HOST: 'ic.example',
      ICECAST_SOURCE_PASSWORD: 'srcpw',
      ICECAST_ADMIN_PASSWORD: 'adminpw',
      ICECAST_PORT: '8871',
      PUBLIC_HOSTNAME: 'yt.example.com',
      LOG_LEVEL: 'debug',
      STREAM_TTL_MINUTES: '0',
      PROXY_FILE: proxyFile,
      STREAMLINK_QUALITY: 'best'
    });

    assert.equal(config.port, 9000);
    assert.equal(config.icecast.host, 'ic.example');
    assert.equal(config.icecast.sourcePassword, 'srcpw');
    assert.equal(config.icecast.adminPassword, 'adminpw');
    assert.equal(config.icecast.publicPort, 8871);
    assert.equal(config.publicHostname, 'yt.example.com');
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.streamTtlMinutes, 0);
    assert.deepEqual(config.proxyList, ['http://user:pass@1.2.3.4:8883']);
    assert.equal(config.streamlinkQuality, 'best');
  });

  test('proxyList filters out invalid entries', () => {
    const proxyFile = writeProxyFile('bad-proxies.json', ['http://ok:3128', 'ftp://nope', 42, '']);
    const config = new Config({ PROXY_FILE: proxyFile });

    assert.deepEqual(config.proxyList, ['http://ok:3128']);
  });

  test('missing or unparseable proxy file yields an empty list', () => {
    const missing = new Config({ PROXY_FILE: join(tempDir, 'missing.json') });
    assert.deepEqual(missing.proxyList, []);

    const corrupt = writeProxyFile('corrupt.json', 'not-json{');
    const unparseable = new Config({ PROXY_FILE: corrupt });
    assert.deepEqual(unparseable.proxyList, []);
  });

  test('falls back to defaults when numeric env vars are not parseable', () => {
    const config = new Config({
      PORT: 'not-a-port',
      ICECAST_PORT: 'not-a-port',
      STREAM_TTL_MINUTES: 'lots'
    });

    assert.equal(config.port, 8080);
    assert.equal(config.icecast.publicPort, 8000);
    assert.equal(config.streamTtlMinutes, 15);
  });

  test('config is immutable', () => {
    const config = new Config({});
    assert.throws(() => {
      config.port = 1;
    }, TypeError);
    assert.throws(() => {
      config.icecast.host = 'x';
    }, TypeError);
  });
});

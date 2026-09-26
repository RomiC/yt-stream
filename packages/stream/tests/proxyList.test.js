import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyList } from '../src/proxyList.js';

describe('ProxyList loading', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'yt-stream-proxylist-'));
  after(() => rmSync(tempDir, { recursive: true, force: true }));

  function captureWarnings() {
    const warnings = [];
    return { warnings, warn: (message) => warnings.push(message) };
  }

  function proxyFile(name, content) {
    const path = join(tempDir, name);
    writeFileSync(path, content);
    return path;
  }

  test('loads a valid file preserving order, deduping, without warnings', () => {
    const logger = captureWarnings();
    const path = proxyFile(
      'valid.json',
      '["https://proxy2:3128", "http://user:pass@1.2.3.4:8883", "https://proxy2:3128"]'
    );

    const proxies = new ProxyList(path, logger);

    assert.deepEqual(proxies.proxies, ['https://proxy2:3128', 'http://user:pass@1.2.3.4:8883']);
    assert.deepEqual(logger.warnings, []);
  });

  test('an explicitly empty list is deliberate silence — no warning', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('empty.json', '[]'), logger);

    assert.deepEqual(proxies.proxies, []);
    assert.deepEqual(logger.warnings, []);
  });

  test('a missing file warns and degrades to a direct connection', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(join(tempDir, 'missing.json'), logger);

    assert.deepEqual(proxies.proxies, []);
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /missing.json not found.*connects directly/);
  });

  test('a directory at the path warns (the Docker create_host_path trap)', () => {
    const logger = captureWarnings();
    const dir = join(tempDir, 'proxy.json');
    mkdirSync(dir);

    const proxies = new ProxyList(dir, logger);

    assert.deepEqual(proxies.proxies, []);
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /proxy.json is a directory.*cp proxy.json.example/);
  });

  test('corrupt JSON warns', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('corrupt.json', 'not-json{'), logger);

    assert.deepEqual(proxies.proxies, []);
    assert.match(logger.warnings[0], /not valid JSON/);
  });

  test('a non-array JSON body warns', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('object.json', '{"proxies": []}'), logger);

    assert.deepEqual(proxies.proxies, []);
    assert.match(logger.warnings[0], /must contain a JSON array/);
  });

  test('entries that are all invalid warn', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('invalid.json', '["ftp://nope", 42]'), logger);

    assert.deepEqual(proxies.proxies, []);
    assert.match(logger.warnings[0], /no valid proxy URLs/);
  });

  test('loads socks5/socks5h entries; socks4 and other schemes are rejected', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(
      proxyFile(
        'socks.json',
        '["socks5h://user:pass@proxy:1080", "socks5://proxy:1080", "socks4://proxy:1080", "ftp://nope"]'
      ),
      logger
    );

    assert.deepEqual(proxies.proxies, ['socks5h://user:pass@proxy:1080', 'socks5://proxy:1080']);
    assert.deepEqual(logger.warnings, []);
  });

  test('partially valid entries load the valid remainder without a warning', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('mixed.json', '["http://ok:3128", "ftp://nope"]'), logger);

    assert.deepEqual(proxies.proxies, ['http://ok:3128']);
    assert.deepEqual(logger.warnings, []);
  });
});

describe('ProxyList rotation', () => {
  const tempDirs = [];
  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function captureWarnings() {
    const warnings = [];
    return { warnings, warn: (message) => warnings.push(message) };
  }

  const pool = ['http://a:3128', 'http://b:3128', 'http://c:3128', 'http://d:3128'];

  function poolFrom(entries) {
    const dir = mkdtempSync(join(tmpdir(), 'yt-stream-rotation-'));
    tempDirs.push(dir);
    const path = join(dir, 'proxy.json');
    writeFileSync(path, JSON.stringify(entries));
    return new ProxyList(path, captureWarnings());
  }

  test('an empty pool yields null once (direct connection)', () => {
    const rotation = poolFrom([]).pickProxies();

    assert.equal(rotation.next().value, null);
    assert.ok(rotation.next().done);
  });

  test('a single-proxy pool yields it on every pull', () => {
    const rotation = poolFrom(['http://solo:3128']).pickProxies();

    assert.equal(rotation.next().value, 'http://solo:3128');
    assert.equal(rotation.next().value, 'http://solo:3128');
  });

  test('a rotation yields the whole pool without repeats, then wraps', () => {
    const rotation = poolFrom(pool).pickProxies();

    const picks = pool.map(() => rotation.next().value);

    assert.equal(new Set(picks).size, pool.length);
    assert.ok(pool.includes(rotation.next().value), 'wrapping continues the pulls');
  });

  test('a rotation follows the shuffle order (deterministic under mocked random)', (context) => {
    context.mock.method(Math, 'random', () => 0);
    const rotation = poolFrom(pool).pickProxies();

    // random() = 0 collapses every Fisher-Yates swap onto index 0: [a,b,c,d] -> [b,c,d,a]
    const picks = pool.map(() => rotation.next().value);
    assert.deepEqual(picks, ['http://b:3128', 'http://c:3128', 'http://d:3128', 'http://a:3128']);
  });

  test('rotations are independent — per-request state', () => {
    const proxies = poolFrom(pool);
    const first = proxies.pickProxies();
    first.next();
    first.next();

    const second = proxies.pickProxies();
    const picks = pool.map(() => second.next().value);

    assert.equal(new Set(picks).size, pool.length, 'another rotation draining does not affect it');
  });
});

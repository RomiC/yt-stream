import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyList } from '../src/proxyList';

function captureWarnings() {
  const warnings: string[] = [];
  return { warnings, warn: (message: string) => warnings.push(message) };
}

describe('ProxyList loading', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'yt-stream-proxylist-'));
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  function proxyFile(name: string, content: string): string {
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

    expect(proxies.proxies).toEqual(['https://proxy2:3128', 'http://user:pass@1.2.3.4:8883']);
    expect(logger.warnings).toEqual([]);
  });

  test('an explicitly empty list is deliberate silence — no warning', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('empty.json', '[]'), logger);

    expect(proxies.proxies).toEqual([]);
    expect(logger.warnings).toEqual([]);
  });

  test('a missing file warns and degrades to a direct connection', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(join(tempDir, 'missing.json'), logger);

    expect(proxies.proxies).toEqual([]);
    expect(logger.warnings.length).toBe(1);
    expect(logger.warnings[0]).toMatch(/missing.json not found.*connects directly/);
  });

  test('a directory at the path warns (the Docker create_host_path trap)', () => {
    const logger = captureWarnings();
    const dir = join(tempDir, 'proxy.json');
    mkdirSync(dir);

    const proxies = new ProxyList(dir, logger);

    expect(proxies.proxies).toEqual([]);
    expect(logger.warnings.length).toBe(1);
    expect(logger.warnings[0]).toMatch(/proxy.json is a directory.*cp proxy.json.example/);
  });

  test('corrupt JSON warns', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('corrupt.json', 'not-json{'), logger);

    expect(proxies.proxies).toEqual([]);
    expect(logger.warnings[0]).toMatch(/not valid JSON/);
  });

  test('a non-array JSON body warns', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('object.json', '{"proxies": []}'), logger);

    expect(proxies.proxies).toEqual([]);
    expect(logger.warnings[0]).toMatch(/must contain a JSON array/);
  });

  test('entries that are all invalid warn', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('invalid.json', '["ftp://nope", 42]'), logger);

    expect(proxies.proxies).toEqual([]);
    expect(logger.warnings[0]).toMatch(/no valid proxy URLs/);
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

    expect(proxies.proxies).toEqual(['socks5h://user:pass@proxy:1080', 'socks5://proxy:1080']);
    expect(logger.warnings).toEqual([]);
  });

  test('partially valid entries load the valid remainder without a warning', () => {
    const logger = captureWarnings();

    const proxies = new ProxyList(proxyFile('mixed.json', '["http://ok:3128", "ftp://nope"]'), logger);

    expect(proxies.proxies).toEqual(['http://ok:3128']);
    expect(logger.warnings).toEqual([]);
  });
});

describe('ProxyList rotation', () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function poolFrom(entries: string[]): ProxyList {
    const dir = mkdtempSync(join(tmpdir(), 'yt-stream-rotation-'));
    tempDirs.push(dir);
    const path = join(dir, 'proxy.json');
    writeFileSync(path, JSON.stringify(entries));
    return new ProxyList(path, captureWarnings());
  }

  const pool = ['http://a:3128', 'http://b:3128', 'http://c:3128', 'http://d:3128'];

  test('an empty pool yields null once (direct connection)', () => {
    const rotation = poolFrom([]).pickProxies();

    expect(rotation.next().value).toBeNull();
    expect(rotation.next().done).toBe(true);
  });

  test('a single-proxy pool yields it on every pull', () => {
    const rotation = poolFrom(['http://solo:3128']).pickProxies();

    expect(rotation.next().value).toBe('http://solo:3128');
    expect(rotation.next().value).toBe('http://solo:3128');
  });

  test('a rotation yields the whole pool without repeats, then wraps', () => {
    const rotation = poolFrom(pool).pickProxies();

    const picks = pool.map(() => rotation.next().value);

    expect(new Set(picks).size).toBe(pool.length);
    expect(pool.includes(rotation.next().value as string)).toBe(true);
  });

  test('a rotation follows the shuffle order (deterministic under mocked random)', () => {
    const spy = spyOn(Math, 'random').mockImplementation(() => 0);
    const rotation = poolFrom(pool).pickProxies();

    // random() = 0 collapses every Fisher-Yates swap onto index 0: [a,b,c,d] -> [b,c,d,a]
    const picks = pool.map(() => rotation.next().value);
    expect(picks).toEqual(['http://b:3128', 'http://c:3128', 'http://d:3128', 'http://a:3128']);

    spy.mockRestore();
  });

  test('rotations are independent — per-request state', () => {
    const proxies = poolFrom(pool);
    const first = proxies.pickProxies();
    first.next();
    first.next();

    const second = proxies.pickProxies();
    const picks = pool.map(() => second.next().value);

    expect(new Set(picks).size).toBe(pool.length);
  });
});

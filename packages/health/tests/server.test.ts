import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from '../src/server';
import type { Checker } from '../src/check';

function checker(result: 'ok' | 'error'): Checker {
  return { check: async () => ({ result, duration: 1 }) };
}

function services(caddy: 'ok' | 'error' = 'ok', icecast: 'ok' | 'error' = 'ok', stream: 'ok' | 'error' = 'ok') {
  return {
    caddyCheck: checker(caddy),
    icecastCheck: checker(icecast),
    streamCheck: checker(stream)
  };
}

let activeServer: ReturnType<typeof createServer> | null = null;

afterEach(() => {
  activeServer?.stop(true);
  activeServer = null;
});

// `routes` are only dispatched for real connections; `server.fetch` bypasses them.
function request(server: ReturnType<typeof createServer>, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`);
}

describe('health server', () => {
  test('GET /hc returns 200 and the aggregated checks when healthy', async () => {
    activeServer = createServer({ services: services() });

    const response = await request(activeServer, '/hc');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      caddy: { result: 'ok', duration: 1 },
      icecast: { result: 'ok', duration: 1 },
      stream: { result: 'ok', duration: 1 }
    });
  });

  test('GET /hc returns 503 when any check failed', async () => {
    activeServer = createServer({ services: services('ok', 'error', 'ok') });

    const response = await request(activeServer, '/hc');

    expect(response.status).toBe(503);
  });

  test('GET /health is an alias of /hc', async () => {
    activeServer = createServer({ services: services() });

    const response = await request(activeServer, '/health');

    expect(response.status).toBe(200);
  });

  test('unknown routes return 404', async () => {
    activeServer = createServer({ services: services() });

    const response = await request(activeServer, '/nope');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: 404, error: '"/nope"' });
  });

  test('adds rate-limit headers to health responses', async () => {
    activeServer = createServer({ services: services(), rateLimitMax: 5 });

    const response = await request(activeServer, '/hc');

    expect(response.headers.get('x-ratelimit-limit')).toBe('5');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('4');
    expect(Number(response.headers.get('x-ratelimit-reset'))).toBeGreaterThan(0);
  });

  test('rate limits after the allowed requests', async () => {
    activeServer = createServer({ services: services(), rateLimitMax: 2 });

    expect((await request(activeServer, '/hc')).status).toBe(200);
    expect((await request(activeServer, '/hc')).status).toBe(200);
    expect((await request(activeServer, '/hc')).status).toBe(429);
  });

  test('the 429 carries rate-limit headers and a message', async () => {
    activeServer = createServer({ services: services(), rateLimitMax: 1 });
    await request(activeServer, '/hc');

    const response = await request(activeServer, '/hc');
    const body = (await response.json()) as { status: number; error: string };

    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-limit')).toBe('1');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(Number(response.headers.get('x-ratelimit-reset'))).toBeGreaterThan(0);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(body.status).toBe(429);
    expect(body.error).toMatch(/^You've reached your limit of 1 requests\. Try again in \d+s\.$/);
  });

  test('an unexpected check failure returns 500 via the error handler', async () => {
    activeServer = createServer({
      services: {
        caddyCheck: {
          check: async () => {
            throw new Error('boom');
          }
        },
        icecastCheck: checker('ok'),
        streamCheck: checker('ok')
      }
    });

    const response = await request(activeServer, '/hc');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 500, error: 'Internal Server Error' });
  });
});

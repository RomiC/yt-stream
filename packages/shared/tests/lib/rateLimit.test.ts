import { describe, expect, test } from 'bun:test';
import { withRateLimit } from '../../lib/withRateLimit';

const handler = async () => Response.json({ ok: true });

function serverAt(address: string) {
  return { requestIP: () => ({ address }) } as unknown as Bun.Server<undefined>;
}

function limiter(options: { max: number; timeWindowMs: number }, address = '127.0.0.1') {
  const wrapped = withRateLimit(handler, options);
  return () => wrapped(new Request('http://localhost/hc'), serverAt(address));
}

describe('withRateLimit', () => {
  test('passes the response through and adds rate-limit headers under the limit', async () => {
    const call = limiter({ max: 2, timeWindowMs: 60_000 });

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-ratelimit-limit')).toBe('2');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('1');
    expect(await response.json()).toEqual({ ok: true });
  });

  test('allows up to max, then returns 429 with retry-after', async () => {
    const call = limiter({ max: 2, timeWindowMs: 60_000 });

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);

    const response = await call();

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeDefined();
  });

  test('reports the remaining allowance, never below zero', async () => {
    const call = limiter({ max: 3, timeWindowMs: 60_000 });

    expect((await call()).headers.get('x-ratelimit-remaining')).toBe('2');
    expect((await call()).headers.get('x-ratelimit-remaining')).toBe('1');
    expect((await call()).headers.get('x-ratelimit-remaining')).toBe('0');
    expect((await call()).headers.get('x-ratelimit-remaining')).toBe('0');
  });

  test('tracks clients independently', async () => {
    const wrapped = withRateLimit(handler, { max: 1, timeWindowMs: 60_000 });
    const call = (address: string) => wrapped(new Request('http://localhost/hc'), serverAt(address));

    expect((await call('10.0.0.1')).status).toBe(200);
    expect((await call('10.0.0.2')).status).toBe(200);
    expect((await call('10.0.0.1')).status).toBe(429);
  });

  test('evicts the oldest live client when the store exceeds 5,000 entries', async () => {
    const wrapped = withRateLimit(handler, { max: 1, timeWindowMs: 3_600_000 });
    const request = new Request('http://localhost/hc');
    const call = (index: number) => wrapped(request, serverAt(`10.0.${Math.floor(index / 256)}.${index % 256}`));

    for (let index = 0; index < 5_000; index += 1) {
      await call(index);
    }

    expect((await call(5_000)).status).toBe(200);
    expect((await call(1)).status).toBe(429);
    expect((await call(0)).status).toBe(200);
  });

  test('retains recently used clients when evicting at capacity', async () => {
    const wrapped = withRateLimit(handler, { max: 1, timeWindowMs: 3_600_000 });
    const request = new Request('http://localhost/hc');
    const call = (index: number) => wrapped(request, serverAt(`10.0.${Math.floor(index / 256)}.${index % 256}`));

    for (let index = 0; index < 5_000; index += 1) {
      await call(index);
    }

    expect((await call(0)).status).toBe(429);
    expect((await call(5_000)).status).toBe(200);
    expect((await call(0)).status).toBe(429);
    expect((await call(2)).status).toBe(429);
    expect((await call(1)).status).toBe(200);
  });

  test('resets once the window elapses', async () => {
    const call = limiter({ max: 1, timeWindowMs: 20 });

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await call()).status).toBe(200);
  });

  test('reports the reset window via x-ratelimit-reset', async () => {
    const call = limiter({ max: 1, timeWindowMs: 60_000 });

    const response = await call();

    expect(Number(response.headers.get('x-ratelimit-reset'))).toBeGreaterThan(0);
  });
});

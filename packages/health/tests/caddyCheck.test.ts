import { describe, expect, test } from 'bun:test';
import { CaddyCheck } from '../src/caddyCheck';
import { deferredFetch } from './helpers';

describe('caddyCheck', () => {
  test('fetches the Caddy liveness endpoint and reports ok', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new CaddyCheck('caddy', 8089).check();

    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0][0]).toBe('http://caddy:8089/hc');
    expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    control.resolve?.(new Response(null, { status: 200 }));

    const result = await resultPromise;
    expect(result.result).toBe('ok');
    expect(result.duration).toBeGreaterThanOrEqual(0);

    spy.mockRestore();
  });

  test('reports an error on a non-ok response', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new CaddyCheck('caddy', 8089).check();

    control.resolve?.(new Response(null, { status: 500, statusText: 'Internal Server Error' }));

    const result = await resultPromise;
    expect(result.result).toBe('error');
    expect(result.error).toBe('HTTP 500: Internal Server Error');

    spy.mockRestore();
  });

  test('reports an error when fetch rejects', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new CaddyCheck('caddy', 8089).check();

    control.reject?.(new Error('Network error'));

    const result = await resultPromise;
    expect(result.result).toBe('error');
    expect(result.error).toBe('Network error');

    spy.mockRestore();
  });
});

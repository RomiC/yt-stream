import { describe, expect, test } from 'bun:test';
import { StreamCheck } from '../src/streamCheck';
import { deferredFetch } from './helpers';

describe('streamCheck', () => {
  test('fetches the stream state endpoint and reports ok', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new StreamCheck('stream', 8080).check();

    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0][0]).toBe('http://stream:8080/api/state');
    expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    control.resolve?.(new Response(null, { status: 200 }));

    const result = await resultPromise;
    expect(result.result).toBe('ok');

    spy.mockRestore();
  });

  test('reports an error on a non-ok response', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new StreamCheck('stream', 8080).check();

    control.resolve?.(new Response(null, { status: 500, statusText: 'Internal Server Error' }));

    const result = await resultPromise;
    expect(result.result).toBe('error');
    expect(result.error).toBe('HTTP 500: Internal Server Error');

    spy.mockRestore();
  });

  test('reports an error when fetch rejects', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new StreamCheck('stream', 8080).check();

    control.reject?.(new Error('Network error'));

    const result = await resultPromise;
    expect(result.result).toBe('error');
    expect(result.error).toBe('Network error');

    spy.mockRestore();
  });
});

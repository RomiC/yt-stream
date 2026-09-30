import { describe, expect, test } from 'bun:test';
import { IcecastCheck } from '../src/icecastCheck';
import { deferredFetch } from './helpers';

describe('icecastCheck', () => {
  test('fetches the Icecast admin stats with basic auth and reports ok', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new IcecastCheck('icecast', 8081, 'test-admin-password').check();

    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0][0]).toBe('http://icecast:8081/admin/stats');
    expect(spy.mock.calls[0][1]?.headers).toEqual({
      Authorization: 'Basic YWRtaW46dGVzdC1hZG1pbi1wYXNzd29yZA=='
    });
    expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    control.resolve?.(new Response(null, { status: 200 }));

    const result = await resultPromise;
    expect(result.result).toBe('ok');

    spy.mockRestore();
  });

  test('reports an error on a non-ok response', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new IcecastCheck('icecast', 8081, 'test-admin-password').check();

    control.resolve?.(new Response(null, { status: 500, statusText: 'Internal Server Error' }));

    const result = await resultPromise;
    expect(result.result).toBe('error');
    expect(result.error).toBe('HTTP 500: Internal Server Error');

    spy.mockRestore();
  });

  test('reports an error when fetch rejects', async () => {
    const { spy, control } = deferredFetch();
    const resultPromise = new IcecastCheck('icecast', 8081, 'test-admin-password').check();

    control.reject?.(new Error('Network error'));

    const result = await resultPromise;
    expect(result.result).toBe('error');
    expect(result.error).toBe('Network error');

    spy.mockRestore();
  });
});

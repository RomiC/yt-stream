import { before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert';
import { CaddyCheck } from '../src/caddyCheck.js';

describe('caddyCheck', () => {
  let fetchMock;

  before(() => {
    fetchMock = mock.method(global, 'fetch', async () => {
      const { promise, resolve, reject } = Promise.withResolvers();

      fetchMock._resolve = resolve;
      fetchMock._reject = reject;

      return promise;
    });
  });

  beforeEach(() => {
    global.fetch.mock.resetCalls();
    fetchMock._resolve = null;
    fetchMock._reject = null;
  });

  test('should fetch and return stream health status', async () => {
    const streamCheck = new CaddyCheck('caddy', 8089);

    const checkPromise = streamCheck.check();

    assert.deepStrictEqual(checkPromise instanceof Promise, true);
    assert.deepStrictEqual(global.fetch.mock.callCount(), 1);

    const [url, options] = global.fetch.mock.calls[0].arguments;

    assert.equal(url, 'http://caddy:8089/hc');
    assert.deepStrictEqual(options, { signal: AbortSignal.timeout(5000) });

    await fetchMock._resolve(new Response(null, { status: 200 }));

    const result = await checkPromise;
    assert.deepStrictEqual(result.result, 'ok');
    assert.deepStrictEqual(isNaN(result.duration), false);
    assert.deepStrictEqual(result.duration >= 0, true);
  });

  test('should return error status on fetch failure', async () => {
    const streamCheck = new CaddyCheck('caddy', 8089);

    const checkPromise = streamCheck.check();

    await fetchMock._resolve(new Response(null, { status: 500, statusText: 'Internal Server Error' }));

    const result = await checkPromise;
    assert.deepStrictEqual(result.result, 'error');
    assert.deepStrictEqual(isNaN(result.duration), false);
    assert.deepStrictEqual(result.duration >= 0, true);
    assert.deepStrictEqual(result.error, 'HTTP 500: Internal Server Error');
  });

  test('should return error status on fetch exception', async () => {
    const streamCheck = new CaddyCheck('caddy', 8089);

    const checkPromise = streamCheck.check();

    await fetchMock._reject(new Error('Network error'));

    const result = await checkPromise;
    assert.deepStrictEqual(result.result, 'error');
    assert.deepStrictEqual(isNaN(result.duration), false);
    assert.deepStrictEqual(result.duration >= 0, true);
    assert.deepStrictEqual(result.error, 'Network error');
  });
});

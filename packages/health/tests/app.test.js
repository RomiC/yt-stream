import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const checks = {
  caddyCheck: { check: async () => ({ result: 'ok', duration: 1 }) },
  icecastCheck: { check: async () => ({ result: 'ok', duration: 1 }) },
  streamCheck: { check: async () => ({ result: 'ok', duration: 1 }) }
};

describe('app', () => {
  test('rate limits /hc after the allowed requests', async () => {
    const app = await createApp({ ...checks, rateLimit: { max: 2 } });

    assert.equal((await app.inject({ method: 'GET', url: '/hc' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/hc' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/hc' })).statusCode, 429);

    await app.close();
  });

  test('rate limits the /health alias as well', async () => {
    const app = await createApp({ ...checks, rateLimit: { max: 1 } });

    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 429);

    await app.close();
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAuth, logRedact } from '../src/auth.js';
import { registerRoutes } from '../src/routes.js';

const KEY = 'test-api-key';

function makeConfig(overrides = {}) {
  return { apiKey: KEY, allowKeyInQuery: false, ...overrides };
}

async function buildApp(config = makeConfig()) {
  const app = Fastify({ logger: false });
  registerAuth(app, { config });
  app.get('/api/ping', async () => ({ pong: true }));
  return app;
}

describe('Auth', () => {
  describe('Bearer header', () => {
    test('valid key passes', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/ping',
        headers: { authorization: `Bearer ${KEY}` }
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { pong: true });
    });

    test('missing key returns 401', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/ping' });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, 'Missing or invalid API key');
    });

    test('wrong key returns 401', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/ping',
        headers: { authorization: 'Bearer wrong-key' }
      });

      assert.equal(res.statusCode, 401);
    });

    test('non-Bearer Authorization scheme returns 401', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/ping',
        headers: { authorization: `Basic ${KEY}` }
      });

      assert.equal(res.statusCode, 401);
    });

    test('empty Bearer value returns 401', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/ping',
        headers: { authorization: 'Bearer ' }
      });

      assert.equal(res.statusCode, 401);
    });
  });

  describe('query param', () => {
    test('rejected by default', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/api/ping?key=${KEY}` });

      assert.equal(res.statusCode, 401);
    });

    test('accepted when allowKeyInQuery is enabled', async () => {
      const app = await buildApp(makeConfig({ allowKeyInQuery: true }));
      const res = await app.inject({ method: 'GET', url: `/api/ping?key=${KEY}` });

      assert.equal(res.statusCode, 200);
    });

    test('wrong query key returns 401 when enabled', async () => {
      const app = await buildApp(makeConfig({ allowKeyInQuery: true }));
      const res = await app.inject({ method: 'GET', url: '/api/ping?key=wrong-key' });

      assert.equal(res.statusCode, 401);
    });

    test('valid header wins over an invalid query key', async () => {
      const app = await buildApp(makeConfig({ allowKeyInQuery: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/api/ping?key=wrong-key',
        headers: { authorization: `Bearer ${KEY}` }
      });

      assert.equal(res.statusCode, 200);
    });
  });

  describe('protects all /api routes', () => {
    function makeDeps() {
      const streamService = {
        start: async () => {},
        stop: async () => {},
        getStatus: async () => ({
          general: { state: 'idle', url: null }
        })
      };
      const healthMonitor = {
        getStatus: async () => ({ general: { health: 'ok', state: 'idle', url: null } })
      };
      return { streamService, healthMonitor };
    }

    async function buildFullApp(config = makeConfig()) {
      const app = Fastify({ logger: false });
      registerAuth(app, { config });
      registerRoutes(app, makeDeps());
      return app;
    }

    test('GET /api/health requires auth', async () => {
      const app = await buildFullApp();

      const noKey = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(noKey.statusCode, 401);

      const withKey = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${KEY}` }
      });
      assert.equal(withKey.statusCode, 200);
    });

    test('GET /api/stream requires auth before url validation', async () => {
      const app = await buildFullApp();
      const res = await app.inject({ method: 'GET', url: '/api/stream?url=not-a-url' });

      assert.equal(res.statusCode, 401);
    });

    test('DELETE /api/stream requires auth', async () => {
      const app = await buildFullApp();
      const res = await app.inject({ method: 'DELETE', url: '/api/stream' });

      assert.equal(res.statusCode, 401);
    });
  });

  describe('log redaction', () => {
    test('key query param never reaches request logs', async () => {
      const chunks = [];
      const app = Fastify({
        logger: {
          level: 'info',
          stream: { write: (chunk) => chunks.push(chunk) },
          redact: logRedact
        }
      });
      registerAuth(app, { config: makeConfig({ allowKeyInQuery: true }) });
      app.get('/api/x', async () => ({}));

      const res = await app.inject({ method: 'GET', url: `/api/x?key=${KEY}` });
      assert.equal(res.statusCode, 200);

      const logged = chunks.join('');
      assert.ok(!logged.includes(KEY), `key leaked to logs: ${logged}`);
      assert.ok(logged.includes('key=[REDACTED]'), `redacted url not logged: ${logged}`);
    });
  });
});

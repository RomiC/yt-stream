import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes.js';

describe('routes', () => {
  let app;

  beforeEach(() => {
    app = Fastify({ logger: false });
  });

  ['/hc', '/health'].forEach((url) => {
    describe(`GET ${url}`, () => {
      test('returns 200 and status', async () => {
        const streamCheckMock = mock.fn(() => Promise.resolve({ result: 'ok', duration: 123 }));
        const icecastCheckMock = mock.fn(() => Promise.resolve({ result: 'ok', duration: 456 }));
        const caddyCheckMock = mock.fn(() => Promise.resolve({ result: 'ok', duration: 789 }));
        registerRoutes(app, {
          // @ts-ignore
          caddyCheck: {
            check: caddyCheckMock
          },
          // @ts-ignore
          icecastCheck: {
            check: icecastCheckMock
          },
          // @ts-ignore
          streamCheck: {
            check: streamCheckMock
          }
        });

        const res = await app.inject({ method: 'GET', url });

        assert.equal(streamCheckMock.mock.callCount(), 1);
        assert.equal(icecastCheckMock.mock.callCount(), 1);
        assert.equal(caddyCheckMock.mock.callCount(), 1);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), {
          stream: { result: 'ok', duration: 123 },
          icecast: { result: 'ok', duration: 456 },
          caddy: { result: 'ok', duration: 789 }
        });
      });

      test('should return 503 if any of checks failed', async () => {
        registerRoutes(app, {
          // @ts-ignore
          caddyCheck: {
            check: () => Promise.resolve({ result: 'error', duration: 999, error: 'Failed to fetch Caddy' })
          },
          // @ts-ignore
          icecastCheck: {
            check: () => Promise.resolve({ result: 'ok', duration: 456 })
          },
          // @ts-ignore
          streamCheck: {
            check: () => Promise.resolve({ result: 'ok', duration: 123 })
          }
        });

        const res = await app.inject({ method: 'GET', url });

        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.json(), {
          stream: { result: 'ok', duration: 123 },
          icecast: { result: 'ok', duration: 456 },
          caddy: { result: 'error', duration: 999, error: 'Failed to fetch Caddy' }
        });
      });
    });
  });
});

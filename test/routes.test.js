import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes.js';
import { sleep } from './helpers.js';

describe('Routes', () => {
  const VALID_URL = 'https://youtube.com/watch?v=abc123';

  function idleStatus() {
    return {
      streamlink: { status: 'stopped' },
      ffmpeg: { status: 'stopped' },
      icecast: { status: 'available', state: 'stopped' },
      general: { state: 'idle', url: null }
    };
  }

  function makeDeps(overrides = {}) {
    const streamService = {
      start: async () => {},
      stop: async () => {},
      getStatus: async () => idleStatus(),
      streamUrl: 'http://localhost:8871/stream'
    };
    const healthMonitor = {
      getStatus: async () => ({ ...idleStatus(), general: { ...idleStatus().general, health: 'ok' } })
    };

    return { streamService, healthMonitor, ...overrides };
  }

  async function buildApp(deps = makeDeps()) {
    const app = Fastify({ logger: false });
    await registerRoutes(app, deps);
    return app;
  }

  describe('GET /stream', () => {
    test('GET /stream with url starts a stream and 302s to the audio mount', async () => {
      const deps = makeDeps();
      const start = mock.fn(async () => {});
      deps.streamService.start = start;
      const app = await buildApp(deps);

      const res = await app.inject({ method: 'GET', url: `/stream?url=${encodeURIComponent(VALID_URL)}` });

      assert.equal(start.mock.callCount(), 1);
      assert.equal(start.mock.calls[0].arguments[0], VALID_URL);
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, 'http://localhost:8871/stream');
    });

    test('GET /stream without url returns 400', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/stream' });

      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, 'Missing url query parameter');
    });

    test('GET /stream with an invalid url returns 400', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/stream?url=not-a-url' });

      assert.equal(res.statusCode, 400);
    });

    test('concurrent start requests: second one gets 429', async () => {
      const deps = makeDeps();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      deps.streamService.start = async () => gate;
      const app = await buildApp(deps);

      const first = app.inject({ method: 'GET', url: `/stream?url=${encodeURIComponent(VALID_URL)}` });
      await sleep(20); // let requestInProgress flip to true

      const second = await app.inject({ method: 'GET', url: `/stream?url=${encodeURIComponent(VALID_URL)}` });
      assert.equal(second.statusCode, 429);

      release();
      await first;
    });

    test('start failure returns 500 with details', async () => {
      const deps = makeDeps();
      deps.streamService.start = async () => {
        throw new Error('boom');
      };
      const app = await buildApp(deps);

      const res = await app.inject({ method: 'GET', url: `/stream?url=${encodeURIComponent(VALID_URL)}` });
      assert.equal(res.statusCode, 500);
      assert.equal(res.json().details, 'boom');
    });
  });
  describe('DELETE /stream', () => {
    test('DELETE /stream stops the active stream', async () => {
      const deps = makeDeps();
      const stop = mock.fn(async () => {});
      deps.streamService.getStatus = async () => ({ ...idleStatus(), general: { state: 'streaming', url: VALID_URL } });
      deps.streamService.stop = stop;
      const app = await buildApp(deps);

      const res = await app.inject({ method: 'DELETE', url: '/stream' });

      assert.equal(stop.mock.callCount(), 1);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { state: 'stopped', youtube_url: VALID_URL });
    });

    test('DELETE /stream with no active stream returns 404', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'DELETE', url: '/stream' });

      assert.equal(res.statusCode, 404);
    });

    test('DELETE /stream after a stopped stream returns 404', async () => {
      const deps = makeDeps();
      deps.streamService.getStatus = async () => ({ ...idleStatus(), general: { state: 'stopped', url: VALID_URL } });
      const app = await buildApp(deps);

      const res = await app.inject({ method: 'DELETE', url: '/stream' });

      assert.equal(res.statusCode, 404);
    });

    test('DELETE /stream while a start is in progress returns 429', async () => {
      const deps = makeDeps();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      deps.streamService.start = async () => gate;
      const app = await buildApp(deps);

      const first = app.inject({ method: 'GET', url: `/stream?url=${encodeURIComponent(VALID_URL)}` });
      await sleep(20);

      const res = await app.inject({ method: 'DELETE', url: '/stream' });
      assert.equal(res.statusCode, 429);

      release();
      await first;
    });
  });
  describe('GET /health', () => {
    test('GET /health returns 200 and the payload when healthy', async () => {
      const deps = makeDeps();
      const app = await buildApp(deps);

      const res = await app.inject({ method: 'GET', url: '/health' });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().general.health, 'ok');
    });

    test('GET /health returns 503 when the verdict is failure', async () => {
      const deps = makeDeps();
      deps.healthMonitor.getStatus = async () => ({
        ...idleStatus(),
        general: { state: 'idle', url: null, health: 'failure' }
      });
      const app = await buildApp(deps);

      const res = await app.inject({ method: 'GET', url: '/health' });

      assert.equal(res.statusCode, 503);
      assert.equal(res.json().general.health, 'failure');
    });

    test('GET /health passes through the full payload', async () => {
      const payload = {
        streamlink: { status: 'running' },
        ffmpeg: { status: 'running' },
        icecast: { status: 'available', state: 'streaming' },
        general: { state: 'streaming', url: VALID_URL, health: 'ok' }
      };
      const deps = makeDeps();
      deps.healthMonitor.getStatus = async () => payload;
      const app = await buildApp(deps);

      const res = await app.inject({ method: 'GET', url: '/health' });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), payload);
    });
  });
});

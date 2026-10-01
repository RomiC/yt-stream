import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Config, silentLogger } from 'yt-stream-shared';
import { createServer } from '../src/server';
import { StatusReport } from '../src/statusReport';
import type { StreamStatus } from '../src/status';
import type { Stream } from '../src/stream';

const KEY = 'test-api-key';
const VALID_URL = 'https://youtube.com/watch?v=abc123';

const config = new Config({ API_KEY: KEY });

function idleStatus(): StreamStatus {
  return {
    streamlink: { status: 'stopped' },
    ffmpeg: { status: 'stopped' },
    icecast: { status: 'available', state: 'stopped', listeners: 0 },
    general: { state: 'idle', url: null }
  };
}

interface Deps {
  stream: Stream;
  statusReport: StatusReport;
}

function makeDeps(overrides: { stream?: Record<string, unknown>; report?: () => Promise<StreamStatus> } = {}): Deps {
  const stream = {
    start: async () => {},
    stop: async () => {},
    getStatus: async () => idleStatus(),
    streamUrl: 'https://yts.example.com/stream',
    ...overrides.stream
  };

  return {
    stream: stream as unknown as Stream,
    statusReport: new StatusReport({ stream: { getStatus: overrides.report ?? (async () => idleStatus()) } })
  };
}

let activeServer: ReturnType<typeof createServer> | null = null;

function start(deps: Deps = makeDeps()) {
  activeServer = createServer({ config, port: 0, ...deps });
  return activeServer;
}

afterEach(() => {
  activeServer?.stop(true);
  activeServer = null;
});

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${activeServer!.port}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { authorization: `Bearer ${KEY}`, ...init?.headers }
  });
}

describe('Stream server', () => {
  describe('log redaction', () => {
    test.each([
      ['ordinary key', `key=${KEY}`],
      ['percent-encoded param name', `k%65y=${KEY}`],
      ['percent-encoded param value', 'key=%74est%2Dapi%2Dkey']
    ])('%s never reaches request logs', async (_name, query) => {
      const logger = { ...silentLogger(), info: mock() };
      activeServer = createServer({
        config: new Config({ API_KEY: KEY, ALLOW_KEY_IN_QUERY: 'true' }),
        logger,
        port: 0,
        ...makeDeps()
      });

      const response = await fetch(
        `http://127.0.0.1:${activeServer.port}/api/stream?url=${encodeURIComponent(VALID_URL)}&${query}`,
        { redirect: 'manual' }
      );

      expect(response.status).toBe(302);
      expect(logger.info.mock.calls).toContainEqual([
        {
          method: 'GET',
          url: `/api/stream?url=${encodeURIComponent(VALID_URL)}&key=[REDACTED]`,
          statusCode: 302,
          responseTime: expect.any(Number)
        },
        'request completed'
      ]);
      const logged = JSON.stringify(logger.info.mock.calls);
      expect(logged).not.toContain(KEY);
      expect(logged).not.toContain(query.split('=')[1]);
      expect(logged).not.toContain('k%65y');
    });
  });

  describe('GET /api/stream', () => {
    test('with url starts a stream and 302s to the audio mount', async () => {
      const startStream = (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          expect(calls).toBe(1);
        };
      })();
      start(makeDeps({ stream: { start: startStream } }));

      const response = await request(`/api/stream?url=${encodeURIComponent(VALID_URL)}`);

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/stream');
    });

    test('without url returns 400', async () => {
      start();

      const response = await request('/api/stream');

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ status: 400, error: 'Missing url query parameter' });
    });

    test('with an invalid url returns 400', async () => {
      start();

      expect((await request('/api/stream?url=not-a-url')).status).toBe(400);
    });

    test('a start failure returns 500 with details', async () => {
      start(
        makeDeps({
          stream: {
            start: async () => {
              throw new Error('boom');
            }
          }
        })
      );

      const response = await request(`/api/stream?url=${encodeURIComponent(VALID_URL)}`);

      expect(response.status).toBe(500);
      expect((await response.json()).details).toBe('boom');
    });

    test('requires auth before url validation', async () => {
      start();

      const response = await fetch(`http://127.0.0.1:${activeServer!.port}/api/stream?url=not-a-url`);

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/stream', () => {
    test('stops the active stream', async () => {
      start(
        makeDeps({
          stream: { getStatus: async () => ({ ...idleStatus(), general: { state: 'streaming', url: VALID_URL } }) }
        })
      );

      const response = await request('/api/stream', { method: 'DELETE' });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: 'stopped', youtube_url: VALID_URL });
    });

    test('with no active stream returns 404', async () => {
      start();

      const response = await request('/api/stream', { method: 'DELETE' });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ status: 404, error: 'No active stream' });
    });

    test('requires auth', async () => {
      start();

      const response = await fetch(`http://127.0.0.1:${activeServer!.port}/api/stream`, { method: 'DELETE' });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/state', () => {
    test('returns 200 and the payload when healthy', async () => {
      start();

      const response = await request('/api/state');

      expect(response.status).toBe(200);
      expect((await response.json()).general.health).toBe('ok');
    });

    test('returns 503 when the verdict is failure', async () => {
      start(
        makeDeps({
          report: async () => ({
            ...idleStatus(),
            icecast: { status: 'unavailable', state: 'stopped', listeners: 0 },
            general: { state: 'idle', url: null }
          })
        })
      );

      const response = await request('/api/state');

      expect(response.status).toBe(503);
      expect((await response.json()).general.health).toBe('failure');
    });

    test('does NOT require auth', async () => {
      start();

      const response = await fetch(`http://127.0.0.1:${activeServer!.port}/api/state`);

      expect(response.status).toBe(200);
    });
  });
});

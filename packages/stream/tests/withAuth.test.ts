import { describe, expect, test } from 'bun:test';
import { withAuth } from '../src/withAuth';
import type { RequestHandler } from 'yt-stream-shared';

const KEY = 'test-api-key';
const server = { requestIP: () => null } as unknown as Bun.Server<undefined>;

interface AuthConfig {
  apiKey: string;
  allowKeyInQuery: boolean;
}

function makeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { apiKey: KEY, allowKeyInQuery: false, ...overrides };
}

const handler: RequestHandler = () => Response.json({ pong: true });

function call(url: string, headers?: Record<string, string>, config = makeConfig()) {
  return withAuth(handler, config)(new Request(url, { headers }), server);
}

describe('withAuth', () => {
  test('a valid Bearer key passes', async () => {
    const response = await call('http://localhost/api/ping', { authorization: `Bearer ${KEY}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
  });

  test('a missing key returns 401', async () => {
    const response = await call('http://localhost/api/ping');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: 401, error: 'Missing or invalid API key' });
  });

  test('a wrong key returns 401', async () => {
    expect((await call('http://localhost/api/ping', { authorization: 'Bearer wrong-key' })).status).toBe(401);
  });

  test('a non-Bearer Authorization scheme returns 401', async () => {
    expect((await call('http://localhost/api/ping', { authorization: `Basic ${KEY}` })).status).toBe(401);
  });

  test('an empty Bearer value returns 401', async () => {
    expect((await call('http://localhost/api/ping', { authorization: 'Bearer ' })).status).toBe(401);
  });

  test('the query param is rejected by default', async () => {
    expect((await call(`http://localhost/api/ping?key=${KEY}`)).status).toBe(401);
  });

  test('the query param is accepted when allowKeyInQuery is enabled', async () => {
    const response = await call(
      `http://localhost/api/ping?key=${KEY}`,
      undefined,
      makeConfig({ allowKeyInQuery: true })
    );

    expect(response.status).toBe(200);
  });

  test('a wrong query key returns 401 when enabled', async () => {
    const response = await call(
      'http://localhost/api/ping?key=wrong-key',
      undefined,
      makeConfig({ allowKeyInQuery: true })
    );

    expect(response.status).toBe(401);
  });

  test('a valid header wins over an invalid query key', async () => {
    const response = await call(
      'http://localhost/api/ping?key=wrong-key',
      { authorization: `Bearer ${KEY}` },
      makeConfig({ allowKeyInQuery: true })
    );

    expect(response.status).toBe(200);
  });
});

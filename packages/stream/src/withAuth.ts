import { timingSafeEqual } from 'node:crypto';
import { ServerResponse } from 'yt-stream-shared';
import type { Config, RequestHandler } from 'yt-stream-shared';

type AuthConfig = Pick<Config, 'apiKey' | 'allowKeyInQuery'>;

function extractApiKey(request: Request, allowQuery: boolean): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const match = /^Bearer (.+)$/.exec(authorization);
    return match ? match[1] : null;
  }

  if (allowQuery) {
    const key = new URL(request.url).searchParams.get('key');
    if (key !== null) {
      return key;
    }
  }

  return null;
}

function keysMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export function withAuth(handler: RequestHandler, config: AuthConfig): RequestHandler {
  return (request, server) => {
    const provided = extractApiKey(request, config.allowKeyInQuery);

    if (provided === null || !keysMatch(provided, config.apiKey)) {
      return ServerResponse.error(401, 'Missing or invalid API key');
    }

    return handler(request, server);
  };
}

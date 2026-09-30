import { ServerResponse, withRateLimit } from 'yt-stream-shared';
import { RATE_LIMIT_MAX } from './config';
import { silentLogger } from './logger';
import type { Checker } from './check';
import type { Logger } from './logger';

export interface HealthServices {
  caddyCheck: Checker;
  icecastCheck: Checker;
  streamCheck: Checker;
}

export interface HealthServerOptions {
  services: HealthServices;
  logger?: Logger;
  port?: number;
  hostname?: string;
  rateLimitMax?: number;
}

const TIME_WINDOW_MS = 60_000;

export function createServer({
  services,
  logger = silentLogger(),
  port = 0,
  hostname = '0.0.0.0',
  rateLimitMax = RATE_LIMIT_MAX
}: HealthServerOptions) {
  const healthEndpoint = withRateLimit(
    async () => {
      const [caddy, icecast, stream] = await Promise.all([
        services.caddyCheck.check(),
        services.icecastCheck.check(),
        services.streamCheck.check()
      ]);

      const allOk = caddy.result === 'ok' && icecast.result === 'ok' && stream.result === 'ok';

      return Response.json({ caddy, icecast, stream }, { status: allOk ? 200 : 503 });
    },
    { max: rateLimitMax, timeWindowMs: TIME_WINDOW_MS }
  );

  const server = Bun.serve({
    port,
    hostname,
    routes: {
      '/hc': { GET: healthEndpoint },
      '/health': { GET: healthEndpoint },
      '/*': (request: Request) => ServerResponse.notFound(new URL(request.url))
    },
    error(err) {
      logger.error({ err: err.message }, 'request failed');

      return ServerResponse.internalError();
    }
  });

  logger.info({ address: server.url.href }, 'server listening');

  return server;
}

import { ServerResponse, silentLogger } from 'yt-stream-shared';
import { withAuth } from './withAuth';
import { withLock } from './withLock';
import { withLogging } from './withLogging';
import { isValidYoutubeUrl } from './utils/isValidYoutubeUrl';
import type { Config, Logger } from 'yt-stream-shared';
import type { Lock } from './withLock';
import type { StatusReport } from './statusReport';
import type { Stream } from './stream';

export interface StreamServerOptions {
  config: Config;
  stream: Stream;
  statusReport: StatusReport;
  logger?: Logger;
  port?: number;
  hostname?: string;
}

export function createServer({
  config,
  stream,
  statusReport,
  logger = silentLogger(),
  port = config.stream.port,
  hostname = '0.0.0.0'
}: StreamServerOptions) {
  const lock: Lock = { inProgress: false };

  const stateEndpoint = async (): Promise<Response> => {
    const state = await statusReport.getStatus();

    return Response.json(state, { status: state.general.health === 'ok' ? 200 : 503 });
  };

  const startStream = async (request: Request): Promise<Response> => {
    const url = new URL(request.url).searchParams.get('url');

    if (!url) {
      return ServerResponse.error(400, 'Missing url query parameter');
    }
    if (!isValidYoutubeUrl(url)) {
      return ServerResponse.error(400, 'Invalid or missing YouTube URL');
    }

    try {
      await stream.start(url);
      return new Response(null, { status: 302, headers: { location: '/stream' } });
    } catch (err) {
      return ServerResponse.error(500, 'Failed to start stream', { details: (err as Error).message });
    }
  };

  const stopStream = async (): Promise<Response> => {
    const status = await stream.getStatus();

    if (status.general.state === 'idle' || status.general.state === 'stopped') {
      return ServerResponse.error(404, 'No active stream');
    }

    await stream.stop();

    return Response.json({ state: 'stopped', youtube_url: status.general.url });
  };

  const server = Bun.serve({
    port,
    hostname,
    routes: {
      '/api/state': { GET: withLogging(stateEndpoint, logger) },
      '/api/stream': {
        GET: withLogging(withAuth(withLock(startStream, lock), config), logger),
        DELETE: withLogging(withAuth(withLock(stopStream, lock), config), logger)
      },
      '/*': withLogging((request: Request) => ServerResponse.notFound(new URL(request.url)), logger)
    },
    error(err) {
      logger.error({ err: err.message }, 'request failed');

      return ServerResponse.internalError();
    }
  });

  logger.info({ address: server.url.href }, 'server listening');

  return server;
}

import { redactApiKey } from './utils/redactApiKey';
import type { Logger, RequestHandler } from 'yt-stream-shared';

export function withLogging(handler: RequestHandler, logger: Logger): RequestHandler {
  return async (request, server) => {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const response = await handler(request, server);

    logger.info(
      {
        method: request.method,
        url: redactApiKey(`${url.pathname}${url.search}`),
        statusCode: response.status,
        responseTime: Date.now() - startedAt
      },
      'request completed'
    );

    return response;
  };
}

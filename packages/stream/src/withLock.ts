import { ServerResponse } from 'yt-stream-shared';
import type { RequestHandler } from 'yt-stream-shared';

export interface Lock {
  inProgress: boolean;
}

export function withLock(handler: RequestHandler, lock: Lock): RequestHandler {
  return async (request, server) => {
    if (lock.inProgress) {
      return ServerResponse.error(429, 'A stream operation is in progress');
    }

    lock.inProgress = true;
    try {
      return await handler(request, server);
    } finally {
      lock.inProgress = false;
    }
  };
}

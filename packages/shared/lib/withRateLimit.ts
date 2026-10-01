import { ServerResponse } from './serverResponse';
import type { RequestHandler } from './types';

export interface RateLimitCheckResult {
  limit: number;
  remaining: number;
  exceeded: boolean;
  resetMs: number;
}

export interface RateLimiterOptions {
  max: number;
  timeWindowMs: number;
}

interface WindowEntry {
  count: number;
  startMs: number;
}

const MAX_TRACKED_KEYS = 5_000;

function createRateLimiter({ max, timeWindowMs }: RateLimiterOptions): (key: string) => RateLimitCheckResult {
  const windows = new Map<string, WindowEntry>();

  return (key: string): RateLimitCheckResult => {
    const nowMs = Date.now();
    const existing = windows.get(key);
    const alive = existing !== undefined && existing.startMs + timeWindowMs > nowMs;

    const entry = alive ? { count: existing.count + 1, startMs: existing.startMs } : { count: 1, startMs: nowMs };
    windows.delete(key);
    windows.set(key, entry);

    if (windows.size > MAX_TRACKED_KEYS) {
      windows.delete(windows.keys().next().value!);
    }

    return {
      limit: max,
      remaining: Math.max(0, max - entry.count),
      exceeded: entry.count > max,
      resetMs: Math.max(0, timeWindowMs - (nowMs - entry.startMs))
    };
  };
}

export function withRateLimit(handler: RequestHandler, options: RateLimiterOptions): RequestHandler {
  const check = createRateLimiter(options);

  return async (request, server) => {
    const checkResult = check(clientKey(server.requestIP(request)?.address));

    if (checkResult.exceeded) {
      return ServerResponse.tooManyRequests(checkResult);
    }

    return ServerResponse.withRateLimitHeaders(await handler(request, server), checkResult);
  };
}

function clientKey(address: string | undefined): string {
  if (!address) {
    return 'unknown';
  }

  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1] : normalized;
}

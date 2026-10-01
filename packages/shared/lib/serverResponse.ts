import type { RateLimitCheckResult } from './withRateLimit';

export class ServerResponse {
  static error(status: number, error: string, extra?: Record<string, unknown>): Response {
    return Response.json({ status, error, ...extra }, { status });
  }

  static notFound(url: URL): Response {
    return ServerResponse.error(404, `"${url.pathname}${url.search}"`);
  }

  static internalError(): Response {
    return ServerResponse.error(500, 'Internal Server Error');
  }

  static tooManyRequests(checkResult: RateLimitCheckResult): Response {
    return Response.json(
      {
        status: 429,
        error: `You've reached your limit of ${checkResult.limit} requests. Try again in ${Math.ceil(checkResult.resetMs / 1_000)}s.`
      },
      { status: 429, headers: ServerResponse.rateLimitHeaders(checkResult) }
    );
  }

  static rateLimitHeaders({ limit, remaining, resetMs, exceeded }: RateLimitCheckResult): Record<string, string> {
    const resetSeconds = String(Math.ceil(resetMs / 1_000));
    const headers: Record<string, string> = {
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': resetSeconds
    };

    if (exceeded) {
      headers['retry-after'] = resetSeconds;
    }

    return headers;
  }

  static withRateLimitHeaders(response: Response, checkResult: RateLimitCheckResult): Response {
    const headers = new Headers(response.headers);

    for (const [name, value] of Object.entries(ServerResponse.rateLimitHeaders(checkResult))) {
      headers.set(name, value);
    }

    return new Response(response.body, { status: response.status, headers });
  }
}

import { timingSafeEqual } from 'node:crypto';

/** Pino redact rules — scrubs the `key` query param from logged request URLs (PRD §3.5). */
export const logRedact = {
  paths: ['req.url'],
  censor: (url) => (typeof url === 'string' ? url.replace(/([?&])key=[^&]*/g, '$1key=[REDACTED]') : '[REDACTED]')
};

function extractApiKey(request, allowQuery) {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer (.+)$/.exec(authorization);
    return match ? match[1] : null;
  }
  if (allowQuery && typeof request.query.key === 'string') {
    return request.query.key;
  }
  return null;
}

function keysMatch(provided, expected) {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

/** API key auth for every route registered on `app` (PRD §3.2). Must run before route registration. */
export function registerAuth(app, { config }) {
  app.addHook('onRequest', async (request, reply) => {
    const provided = extractApiKey(request, config.allowKeyInQuery);

    if (provided === null || !keysMatch(provided, config.apiKey)) {
      reply.code(401);
      return reply.send({ error: 'Missing or invalid API key' });
    }
  });
}

import { timingSafeEqual } from 'node:crypto';

/** Pino redact rules — scrubs the `key` query param from logged request URLs. */
export const logRedact = {
  paths: ['req.url'],
  censor: redactApiKey
};

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// Matches the decoded param name, so percent-encoding (`?k%65y=`) cannot smuggle the key into logs.
function redactApiKey(url) {
  if (typeof url !== 'string') {
    return '[REDACTED]';
  }
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }

  const path = url.slice(0, queryStart);
  const query = url
    .slice(queryStart + 1)
    .split('&')
    .map((pair) => (safeDecode(pair.split('=', 1)[0]) === 'key' ? 'key=[REDACTED]' : pair))
    .join('&');

  return `${path}?${query}`;
}

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

const NON_PROTECTED_PATHS = ['/api/state'];
/**
 * Registers an authentication hook for the Fastify app that checks for a valid API key in the request.
 *
 * @param {import('fastify').FastifyInstance} app - The Fastify instance.
 * @param {Object} options - The options object.
 * @param {import('yt-stream-shared').Config} options.config - The configuration object containing the API key and query allowance.
 */
export function registerAuth(app, { config }) {
  app.addHook('onRequest', async (request, reply) => {
    const provided = extractApiKey(request, config.allowKeyInQuery);
    const url = new URL(request.url, config.publicBaseUrl);

    if (!NON_PROTECTED_PATHS.includes(url.pathname) && (provided === null || !keysMatch(provided, config.apiKey))) {
      reply.code(401);
      return reply.send({ error: 'Missing or invalid API key' });
    }
  });
}

import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { RATE_LIMIT_MAX } from './config.js';
import { registerRoutes } from './routes.js';

/**
 * Builds the health app. The rate limiter must be registered before the
 * routes — Fastify hooks only apply to routes added afterwards.
 *
 * @param {object} deps - check instances and optional rate-limit overrides
 */
export async function createApp({
  caddyCheck,
  icecastCheck,
  streamCheck,
  logger = false,
  rateLimit: rateLimitOptions = {}
}) {
  const app = Fastify({ logger });

  await app.register(rateLimit, {
    global: true,
    max: RATE_LIMIT_MAX,
    timeWindow: '1m',
    ...rateLimitOptions
  });

  registerRoutes(app, { caddyCheck, icecastCheck, streamCheck });

  return app;
}

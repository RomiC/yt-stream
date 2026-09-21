/**
 * Register health routes
 *
 * @param {import('fastify').FastifyInstance} app - Fastify application
 * @param {object} services - List of check services
 * @param {import('./caddyCheck.js').CaddyCheck} services.caddyCheck - Caddy check service
 * @param {import('./icecastCheck.js').IcecastCheck} services.icecastCheck - Icecast check service
 * @param {import('./streamCheck.js').StreamCheck} services.streamCheck - Stream check service
 */
export function registerRoutes(app, services) {
  const { caddyCheck, icecastCheck, streamCheck } = services;

  ['/hc', '/health'].forEach((path) => {
    app.get(path, async (_, reply) => {
      const [caddy, icecast, stream] = await Promise.all([
        caddyCheck.check(),
        icecastCheck.check(),
        streamCheck.check()
      ]);

      if (caddy.result !== 'ok' || icecast.result !== 'ok' || stream.result !== 'ok') {
        reply.code(503);
      }

      return {
        caddy,
        icecast,
        stream
      };
    });
  });
}

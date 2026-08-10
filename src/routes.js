export async function registerRoutes(app, poller) {
  app.get('/health', async (request, reply) => {
    const ice = poller.getStatus();

    const components = {
      icecast: ice.icecastReachable
        ? { status: 'reachable' }
        : { status: 'unreachable', error: 'no response from Icecast admin API' },
    };

    const ok = ice.icecastReachable;

    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      components,
    };
  });
}

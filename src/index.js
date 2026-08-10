import Fastify from 'fastify';
import config from './config.js';
import { registerRoutes } from './routes.js';
import { startPolling } from './icecast-client.js';
import { createStreamManager } from './stream-manager.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
});

const poller = startPolling(app.log);
const streamManager = createStreamManager({ logger: app.log, config });

// Feed Icecast listener counts into TTL checking every 15s
setInterval(() => {
  const status = poller.getStatus();
  streamManager.checkTtl(status.listeners, status.icecastReachable);
}, 15_000);

await registerRoutes(app, poller, streamManager);

await app.listen({ port: config.port, host: '0.0.0.0' });

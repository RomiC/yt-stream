import Fastify from 'fastify';
import config from './config.js';
import { registerRoutes } from './routes.js';
import { startPolling } from './icecast-client.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
});

const poller = startPolling(app.log);

await registerRoutes(app, poller);

await app.listen({ port: config.port, host: '0.0.0.0' });

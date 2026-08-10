import Fastify from 'fastify';
import config from './config.js';
import { registerRoutes } from './routes.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
});

await registerRoutes(app);

await app.listen({ port: config.port, host: '0.0.0.0' });

import Fastify from 'fastify';
import config from './config.js';
import { registerRoutes } from './routes.js';
import { startPolling } from './icecast-client.js';
import { createStreamManager } from './stream-manager.js';
import { createProxyList } from './proxy-list.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
});

const icecast = startPolling(app.log);
const proxyList = createProxyList({ config, logger: app.log });
const streamManager = createStreamManager({ logger: app.log, config, icecast, proxyList });

// Warn if running with default Icecast credentials
if (config.icecast.sourcePassword === 'secret' || config.icecast.adminPassword === 'admin') {
  app.log.warn('Using default Icecast credentials — set ICECAST_SOURCE_PASSWORD and ICECAST_ADMIN_PASSWORD in production');
}

// Feed Icecast status into the stream manager every 15s
setInterval(() => {
  streamManager.checkHealth(icecast.getStatus());
}, 15_000);

await registerRoutes(app, icecast, streamManager, proxyList);

await app.listen({ port: config.port, host: '0.0.0.0' });

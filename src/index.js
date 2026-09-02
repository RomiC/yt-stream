import Fastify from 'fastify';
import { Config } from './config.js';
import { registerAuth, logRedact } from './auth.js';
import { EventBus, Event } from './events.js';
import { Stream } from './stream.js';
import { HealthMonitor } from './healthMonitor.js';
import { registerRoutes } from './routes.js';

const config = new Config();

const app = Fastify({
  logger: { level: config.logLevel, redact: logRedact }
});

const events = new EventBus();
const streamService = new Stream({ config, logger: app.log, events });

events.on(Event.streamStarted, ({ url }) => app.log.info({ url }, 'stream started'));
events.on(Event.streamStopped, ({ url, reason }) => app.log.info({ url, reason }, 'stream stopped'));
events.on(Event.streamError, ({ url, error }) => app.log.error({ url, err: error }, 'stream error'));

if (config.icecast.sourcePassword === 'secret' || config.icecast.adminPassword === 'admin') {
  app.log.warn(
    'Using default Icecast credentials — set ICECAST_SOURCE_PASSWORD and ICECAST_ADMIN_PASSWORD in production'
  );
}

if (config.apiKey === 'dev-api-key') {
  app.log.warn('Using default API key — set API_KEY in production');
}

const healthMonitor = new HealthMonitor({ streamService });

registerAuth(app, { config });
registerRoutes(app, { streamService, healthMonitor });

await app.listen({ port: config.port, host: '0.0.0.0' });

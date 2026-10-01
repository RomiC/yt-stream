import { Config, createLogger } from 'yt-stream-shared';
import { Event, EventBus } from './events';
import { ProxyList } from './proxyList';
import { StatusReport } from './statusReport';
import { Stream } from './stream';
import { createServer } from './server';

const config = new Config();
const logger = createLogger(config.logLevel);

const events = new EventBus();
const proxies = new ProxyList(config.proxyFile, logger);
const stream = new Stream({ config, logger, events, proxies });

events.on(Event.streamStarted, ({ url }) => logger.info({ url }, 'stream started'));
events.on(Event.streamStopped, ({ url, reason }) => logger.info({ url, reason }, 'stream stopped'));
events.on(Event.streamError, ({ url, error }) => logger.error({ url, err: error }, 'stream error'));

if (config.icecast.sourcePassword === 'secret' || config.icecast.adminPassword === 'admin') {
  logger.warn(
    'Using default Icecast credentials — set ICECAST_SOURCE_PASSWORD and ICECAST_ADMIN_PASSWORD in production'
  );
}

if (config.apiKey === 'dev-api-key') {
  logger.warn('Using default API key — set API_KEY in production');
}

const statusReport = new StatusReport({ stream });

createServer({ config, stream, statusReport, logger });

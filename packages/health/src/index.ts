import { Config, createLogger } from 'yt-stream-shared';
import { CaddyCheck } from './caddyCheck';
import { IcecastCheck } from './icecastCheck';
import { StreamCheck } from './streamCheck';
import { createServer } from './server';

const config = new Config();

createServer({
  port: config.health.port,
  logger: createLogger(config.logLevel),
  services: {
    caddyCheck: new CaddyCheck(config.caddyHealth.host, config.caddyHealth.port),
    icecastCheck: new IcecastCheck(config.icecast.host, config.icecast.port, config.icecast.adminPassword),
    streamCheck: new StreamCheck(config.stream.host, config.stream.port, config.apiKey)
  }
});

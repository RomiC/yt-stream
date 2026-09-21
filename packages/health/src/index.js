import { Config } from 'yt-stream-shared';
import { createApp } from './app.js';
import { CaddyCheck } from './caddyCheck.js';
import { IcecastCheck } from './icecastCheck.js';
import { StreamCheck } from './streamCheck.js';

const config = new Config();

const app = await createApp({
  caddyCheck: new CaddyCheck(config.caddyHealth.host, config.caddyHealth.port),
  icecastCheck: new IcecastCheck(config.icecast.host, config.icecast.port, config.icecast.adminPassword),
  streamCheck: new StreamCheck(config.stream.host, config.stream.port),
  logger: { level: config.logLevel }
});

await app.listen({ port: config.health.port, host: '0.0.0.0' });

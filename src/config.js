const config = Object.freeze({
  port: parseInt(process.env.PORT || '8080', 10),
  icecast: Object.freeze({
    host: process.env.ICECAST_HOST || 'icecast',
    port: parseInt(process.env.ICECAST_PORT || '8000', 10),
    sourcePassword: process.env.ICECAST_SOURCE_PASSWORD || 'secret',
    adminPassword: process.env.ICECAST_ADMIN_PASSWORD || 'admin',
  }),
  publicHostname: process.env.PUBLIC_HOSTNAME || 'localhost',
  dataDir: process.env.DATA_DIR || './data',
  logLevel: process.env.LOG_LEVEL || 'info',
  streamTtlMinutes: parseInt(process.env.STREAM_TTL_MINUTES || '15', 10),
  ytdlpProxy: process.env.YTDLP_PROXY || null,
  cookiesPath: process.env.COOKIES_PATH || null,
});

export default config;

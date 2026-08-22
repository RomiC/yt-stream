const config = Object.freeze({
  port: parseInt(process.env.PORT || '8080', 10),
  icecast: Object.freeze({
    host: process.env.ICECAST_HOST || 'icecast',
    port: 8000, // internal container port — never changes
    sourcePassword: process.env.ICECAST_SOURCE_PASSWORD || 'secret',
    adminPassword: process.env.ICECAST_ADMIN_PASSWORD || 'admin',
    publicPort: parseInt(process.env.ICECAST_PORT || '8000', 10), // host-facing port for redirects
  }),
  publicHostname: process.env.PUBLIC_HOSTNAME || 'localhost',
  logLevel: process.env.LOG_LEVEL || 'info',
  streamTtlMinutes: parseInt(process.env.STREAM_TTL_MINUTES || '15', 10),
  proxyFile: process.env.PROXY_FILE || null,
  streamlinkQuality: process.env.STREAMLINK_QUALITY || 'audio_only,worst',
});

export default config;

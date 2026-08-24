import { isValidYoutubeUrl } from './utils/isValidYoutubeUrl.js';

export async function registerRoutes(app, { streamService, healthMonitor }) {
  // Single-flight: at most one start/stop operation at a time (PRD §2).
  let requestInProgress = false;

  // --- GET /health -----------------------------------------------------------

  app.get('/health', async (request, reply) => {
    const health = await healthMonitor.getStatus();
    reply.code(health.general.health === 'ok' ? 200 : 503);
    return health;
  });

  // --- GET /stream -----------------------------------------------------------
  // Status is served by /health; this route only starts a stream.

  app.get('/stream', async (request, reply) => {
    const { url } = request.query;

    if (!url) {
      reply.code(400);
      return { error: 'Missing url query parameter' };
    }

    if (!isValidYoutubeUrl(url)) {
      reply.code(400);
      return { error: 'Invalid or missing YouTube URL' };
    }

    if (requestInProgress) {
      reply.code(429);
      return { error: 'A stream operation is in progress' };
    }

    requestInProgress = true;
    try {
      await streamService.start(url);
      reply.redirect(streamService.streamUrl);
      return;
    } catch (err) {
      reply.code(500);
      return { error: 'Failed to start stream', details: err.message };
    } finally {
      requestInProgress = false;
    }
  });

  // --- DELETE /stream --------------------------------------------------------

  app.delete('/stream', async (request, reply) => {
    if (requestInProgress) {
      reply.code(429);
      return { error: 'A stream operation is in progress' };
    }

    const status = await streamService.getStatus();

    if (status.general.state === 'idle' || status.general.state === 'stopped') {
      reply.code(404);
      return { error: 'No active stream' };
    }

    requestInProgress = true;
    try {
      await streamService.stop();
      return {
        state: 'stopped',
        youtube_url: status.general.url
      };
    } finally {
      requestInProgress = false;
    }
  });
}

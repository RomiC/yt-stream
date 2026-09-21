import { isValidYoutubeUrl } from './utils/isValidYoutubeUrl.js';

/**
 * Registers the routes for the stream service.
 *
 * @param {import('fastify').FastifyInstance} app - The Fastify instance.
 * @param {Object} options - The options object.
 * @param {import('./stream.js').Stream} options.streamService - The stream service instance.
 * @param {import('./serviceState.js').ServiceState} options.serviceState - The service state instance.
 */
export function registerRoutes(app, options) {
  const { streamService, serviceState } = options;
  let requestInProgress = false;

  // --- GET /api/state -------------------------------------------------------

  app.get('/api/state', async (_, reply) => {
    const state = await serviceState.getStatus();
    reply.code(state.general.health === 'ok' ? 200 : 503);
    return state;
  });

  // --- GET /api/stream -------------------------------------------------------
  // Status is served by /api/state; this route only starts a stream.

  app.get('/api/stream', async (request, reply) => {
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
      reply.redirect('/stream');
      return;
    } catch (err) {
      reply.code(500);
      return { error: 'Failed to start stream', details: err.message };
    } finally {
      requestInProgress = false;
    }
  });

  // --- DELETE /api/stream ----------------------------------------------------

  app.delete('/api/stream', async (request, reply) => {
    if (requestInProgress) {
      reply.code(429);
      return { error: 'A stream operation is in progress' };
    }

    requestInProgress = true;
    try {
      const status = await streamService.getStatus();

      if (status.general.state === 'idle' || status.general.state === 'stopped') {
        reply.code(404);
        return { error: 'No active stream' };
      }

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

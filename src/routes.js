import config from './config.js';

export async function registerRoutes(app, poller, streamManager) {
  // --- GET /health -----------------------------------------------------------

  app.get('/health', async (request, reply) => {
    const ice = poller.getStatus();
    const stream = streamManager.getState();

    const components = {
      icecast: ice.icecastReachable
        ? { status: 'reachable', mountpoint_active: ice.mountpointActive }
        : { status: 'unreachable', error: 'no response from Icecast admin API' },
    };

    if (stream.state !== 'idle') {
      components.ffmpeg = {
        status: stream.state === 'streaming' ? 'running' : stream.state,
        ...(stream.pid ? { pid: stream.pid } : {}),
        ...(stream.state === 'streaming' ? { uptime_seconds: stream.uptime_seconds } : {}),
      };
    }

    const ok = ice.icecastReachable;

    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      components,
      ...(stream.state !== 'idle' ? {
        stream: {
          state: stream.state,
          youtube_url: stream.youtube_url,
          listeners: ice.listeners,
        },
      } : {}),
    };
  });

  // --- GET /stream -----------------------------------------------------------

  let requestInProgress = false;

  app.get('/stream', async (request, reply) => {
    const { url } = request.query;

    if (url) {
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
        await streamManager.start(url);
        reply.redirect(streamUrl());
        return;
      } catch (err) {
        reply.code(500);
        return { error: 'Failed to start stream', details: err.message };
      } finally {
        requestInProgress = false;
      }
    }

    return streamManager.getState();
  });

  // --- DELETE /stream --------------------------------------------------------

  app.delete('/stream', async (request, reply) => {
    if (requestInProgress) {
      reply.code(429);
      return { error: 'A stream operation is in progress' };
    }

    const current = streamManager.getState();

    if (current.state === 'idle' || current.state === 'stopped') {
      reply.code(404);
      return { error: 'No active stream' };
    }

    requestInProgress = true;
    try {
      await streamManager.stop();
      return {
        state: 'stopped',
        youtube_url: current.youtube_url,
      };
    } finally {
      requestInProgress = false;
    }
  });
}

function streamUrl() {
  return `http://${config.publicHostname}:${config.icecast.publicPort}/stream`;
}

function isValidYoutubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/|shorts\/)|youtu\.be\/)[\w-]+/.test(url);
}

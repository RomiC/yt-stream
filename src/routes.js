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

  app.get('/stream', async (request, reply) => {
    const { url } = request.query;

    if (url) {
      // Start or redirect
      if (!isValidYoutubeUrl(url)) {
        reply.code(400);
        return { error: 'Invalid or missing YouTube URL' };
      }

      const current = streamManager.getState();

      // Already running with the same URL — idempotent
      if (current.state === 'streaming' && current.youtube_url === url) {
        reply.redirect(streamUrl());
        return;
      }

      // Start the pipeline
      streamManager.start(url);

      // Wait up to 5s for the stream to become active, then redirect
      const started = await waitForStreaming(streamManager, url, 5000);

      if (started) {
        reply.redirect(streamUrl());
        return;
      }

      reply.code(202);
      return { state: 'starting', youtube_url: url };
    }

    // No url param — return current status
    return streamManager.getState();
  });

  // --- DELETE /stream --------------------------------------------------------

  app.delete('/stream', async (request, reply) => {
    const current = streamManager.getState();

    if (current.state === 'idle' || current.state === 'stopped') {
      reply.code(404);
      return { error: 'No active stream' };
    }

    await streamManager.stop();
    const updated = streamManager.getState();

    return {
      state: updated.state,
      youtube_url: updated.youtube_url,
    };
  });
}

function streamUrl() {
  return `http://${config.publicHostname}:${config.icecast.publicPort}/stream`;
}

function waitForStreaming(manager, expectedUrl, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      teardown();
      resolve(false);
    }, timeoutMs);

    function onState({ state, youtube_url }) {
      if (state === 'streaming' && youtube_url === expectedUrl) {
        teardown();
        resolve(true);
      } else if (state === 'stopped' || state === 'error') {
        teardown();
        resolve(false);
      }
    }

    function teardown() {
      clearTimeout(timer);
      manager.off('state', onState);
    }

    manager.on('state', onState);
  });
}

function isValidYoutubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/|shorts\/)|youtu\.be\/)[\w-]+/.test(url);
}

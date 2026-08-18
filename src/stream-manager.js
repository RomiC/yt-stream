import { spawn } from 'child_process';
import { stat } from 'fs/promises';
import { EventEmitter } from 'events';

const VALID_TRANSITIONS = {
  idle: ['starting'],
  starting: ['streaming', 'stopped'],
  streaming: ['stopped', 'starting'],
  stopped: ['starting'],
};

const EXTRACT_TIMEOUT = 60_000;   // yt-dlp extraction can be slow (cookies, VPS latency)
const MOUNTPOINT_TIMEOUT = 30_000; // ffmpeg connecting to YouTube + Icecast

export function createStreamManager({ logger, config, icecast }) {
  const emitter = new EventEmitter();

  let state = 'idle';
  let currentUrl = null;
  let ffmpegProc = null;
  let ffmpegStartedAt = null;
  let idleSince = null;
  let streamUptime = 0;

  function transition(newState) {
    if (!VALID_TRANSITIONS[state]?.includes(newState)) {
      logger.warn({ from: state, to: newState }, 'invalid state transition ignored');
      return;
    }
    logger.info({ from: state, to: newState }, 'state transition');
    state = newState;
    if (newState === 'streaming') {
      ffmpegStartedAt = Date.now();
    }
    if (newState === 'stopped' && ffmpegStartedAt) {
      streamUptime += Math.floor((Date.now() - ffmpegStartedAt) / 1000);
      ffmpegStartedAt = null;
    }
    emitter.emit('state', { state, youtube_url: currentUrl });
  }

  async function extractAudioUrl(youtubeUrl, token) {
    const args = ['-f', 'best[height<=360]', '--get-url'];
    if (config.ytdlpProxy) args.push('--proxy', config.ytdlpProxy);
    if (config.cookiesPath) {
      try {
        const s = await stat(config.cookiesPath);
        if (s.isFile()) args.push('--cookies', config.cookiesPath);
      } catch { /* path doesn't exist, skip */ }
    }
    args.push(youtubeUrl);

    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      if (token) token.ytdlpProc = proc;
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.slice(-200) || `yt-dlp exit ${code}`));
      });
      proc.on('error', reject);
    });
  }

  function spawnFfmpeg(audioUrl) {
    const icecastUrl = `icecast://source:${config.icecast.sourcePassword}@${config.icecast.host}:${config.icecast.port}/stream`;
    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', audioUrl,
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-content_type', 'audio/mpeg',
      '-f', 'mp3',
      icecastUrl,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stderr.on('data', d => {
      logger.debug({ ffmpeg: d.toString().trim() });
    });

    proc.on('close', code => {
      logger.warn({ code, pid: proc.pid }, 'ffmpeg exited');
      if (ffmpegProc === proc) {
        ffmpegProc = null;
        if (state === 'streaming') {
          transition('stopped');
        }
      }
    });

    proc.on('error', err => {
      logger.error({ err: err.message }, 'ffmpeg spawn error');
      if (ffmpegProc === proc) {
        ffmpegProc = null;
        if (state === 'streaming') {
          transition('stopped');
        }
      }
    });

    return proc;
  }

  function killFfmpeg() {
    if (ffmpegProc) {
      const proc = ffmpegProc;
      ffmpegProc = null;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 5000);
    }
  }

  async function start(youtubeUrl) {
    // Idempotent: same URL already streaming — no-op
    if (currentUrl === youtubeUrl && state === 'streaming') {
      return;
    }

    // Stop current pipeline if running
    if (state !== 'idle' && state !== 'stopped') {
      killFfmpeg();
      // Wait for the old source to fully disconnect from Icecast so the
      // mountpoint is released before the new source tries to claim it.
      await withTimeout((async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const s = await icecast.pollNow();
          if (!s.mountpointActive) return;
          await sleep(500);
        }
        logger.warn('old mountpoint still active after 10s, proceeding anyway');
      })(), 10_000);
    }

    currentUrl = youtubeUrl;
    idleSince = null;
    transition('starting');

    // Cancellation token: set when start times out so the still-running
    // yt-dlp extraction can be killed and must not spawn an encoder.
    const token = { cancelled: false, ytdlpProc: null };

    try {
      // Extraction can be slow (cookie-authenticated requests, VPS latency)
      const audioUrl = await withTimeout(
        extractAudioUrl(youtubeUrl, token),
        EXTRACT_TIMEOUT,
      );
      if (token.cancelled) return; // timed out — do not spawn an encoder

      ffmpegProc = spawnFfmpeg(audioUrl);

      // Wait until the Icecast mountpoint is actually active
      await withTimeout((async () => {
        const deadline = Date.now() + MOUNTPOINT_TIMEOUT;
        while (Date.now() < deadline) {
          const s = await icecast.pollNow();
          if (s.mountpointActive) {
            transition('streaming');
            return;
          }
          await sleep(500);
        }
        throw new Error('mountpoint never became active');
      })(), MOUNTPOINT_TIMEOUT);
    } catch (err) {
      token.cancelled = true;
      if (token.ytdlpProc) token.ytdlpProc.kill('SIGKILL');
      logger.error({ err: err.message }, 'failed to start stream');
      killFfmpeg();
      transition('stopped');
      throw err;
    }
  }

  async function stop() {
    if (state === 'idle' || state === 'stopped') return;
    killFfmpeg();
    transition('stopped');
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
    ]);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function checkHealth(iceStatus) {
    if (state !== 'streaming') return;

    // Source died but ffmpeg is still alive retrying input
    if (iceStatus.icecastReachable && !iceStatus.mountpointActive) {
      logger.warn('mountpoint lost while streaming — stopping');
      killFfmpeg();
      transition('stopped');
      return;
    }

    if (config.streamTtlMinutes === 0) return;
    if (!iceStatus.icecastReachable) return;

    if (iceStatus.listeners === 0) {
      if (!idleSince) idleSince = Date.now();
      else if (Date.now() - idleSince >= config.streamTtlMinutes * 60_000) {
        logger.info({ ttlMinutes: config.streamTtlMinutes }, 'TTL expired, stopping stream');
        killFfmpeg();
        transition('stopped');
      }
    } else {
      idleSince = null;
    }
  }

  function getState() {
    const uptime = ffmpegStartedAt
      ? streamUptime + Math.floor((Date.now() - ffmpegStartedAt) / 1000)
      : streamUptime;

    return {
      state,
      ...(currentUrl ? { youtube_url: currentUrl } : {}),
      uptime_seconds: uptime,
      idle_seconds: idleSince ? Math.floor((Date.now() - idleSince) / 1000) : 0,
      bitrate: 128,
      pid: ffmpegProc?.pid ?? null,
    };
  }

  return {
    start,
    stop,
    getState,
    checkHealth,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

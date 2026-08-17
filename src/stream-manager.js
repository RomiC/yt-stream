import { spawn } from 'child_process';
import { stat } from 'fs/promises';
import { EventEmitter } from 'events';

const VALID_TRANSITIONS = {
  idle: ['starting'],
  starting: ['streaming', 'stopped'],
  streaming: ['stopped', 'starting'],
  stopped: ['starting'],
};

const START_TIMEOUT = 15_000;

export function createStreamManager({ logger, config }) {
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
    const args = ['-f', 'bestaudio/best', '--get-url'];
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
    // Idempotent: same URL already active or starting
    if (currentUrl === youtubeUrl && (state === 'streaming' || state === 'starting')) {
      if (state === 'streaming') return;
      return new Promise((resolve, reject) => {
        function onState({ state: s }) {
          if (s === 'streaming') { emitter.off('state', onState); resolve(); }
          if (s === 'stopped') { emitter.off('state', onState); reject(new Error('stream failed')); }
        }
        emitter.on('state', onState);
      });
    }

    // Stop current pipeline if running
    if (state !== 'idle' && state !== 'stopped') {
      killFfmpeg();
    }

    currentUrl = youtubeUrl;
    idleSince = null;
    transition('starting');

    try {
      await withTimeout((async () => {
        const audioUrl = await extractAudioUrl(youtubeUrl, null);
        ffmpegProc = spawnFfmpeg(audioUrl);

        await new Promise(resolve => setTimeout(resolve, 2000));

        if (!ffmpegProc || ffmpegProc.exitCode !== null) {
          throw new Error('ffmpeg failed to start');
        }
        transition('streaming');
      })(), START_TIMEOUT);
    } catch (err) {
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

  function checkTtl(listeners, icecastReachable) {
    if (state !== 'streaming') return;
    if (config.streamTtlMinutes === 0) return;
    if (!icecastReachable) return;

    if (listeners === 0) {
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
    checkTtl,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

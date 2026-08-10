import { spawn } from 'child_process';
import { writeFile, rename, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 60000];
const MAX_RETRIES = 10;

const VALID_TRANSITIONS = {
  idle: ['starting'],
  starting: ['streaming', 'retrying', 'stopped'],
  streaming: ['retrying', 'stopped', 'starting'],
  retrying: ['streaming', 'stopped', 'retrying'],
  stopped: ['starting'],
};

export function createStreamManager({ logger, config }) {
  const emitter = new EventEmitter();
  const STATE_FILE = join(config.dataDir, 'stream-state.json');

  let state = 'idle';
  let currentUrl = null;
  let ffmpegProc = null;
  let ffmpegStartedAt = null;
  let retryCount = 0;
  let retryTimer = null;
  let idleSince = null;
  let streamUptime = 0;
  let activeStart = null;
  let pendingYtdlp = null;
  let generation = 0;

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
    if (newState === 'stopped') {
      streamUptime = ffmpegStartedAt
        ? streamUptime + Math.floor((Date.now() - ffmpegStartedAt) / 1000)
        : streamUptime;
      ffmpegStartedAt = null;
    }
    persist();
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
        else reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-200)}`));
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
        if (state === 'streaming' || state === 'starting') {
          if (code === 0) {
            logger.info('ffmpeg completed successfully, stopping stream');
            transition('stopped');
          } else {
            scheduleRetry();
          }
        }
      }
    });

    proc.on('error', err => {
      logger.error({ err: err.message }, 'ffmpeg spawn error');
      if (ffmpegProc === proc) {
        ffmpegProc = null;
        if (state === 'streaming' || state === 'starting') {
          scheduleRetry();
        }
      }
    });

    return proc;
  }

  function killFfmpeg() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    generation++;
    if (pendingYtdlp) {
      pendingYtdlp.kill('SIGKILL');
      pendingYtdlp = null;
    }
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
    if (currentUrl === youtubeUrl && (state === 'streaming' || state === 'starting' || state === 'retrying')) {
      return;
    }

    // Abort any in-progress start
    if (activeStart) {
      activeStart.aborted = true;
      if (activeStart.ytdlpProc) activeStart.ytdlpProc.kill('SIGKILL');
      activeStart = null;
    }

    // Stop current pipeline if running
    if (state !== 'idle' && state !== 'stopped') {
      killFfmpeg();
    }

    currentUrl = youtubeUrl;
    retryCount = 0;
    idleSince = null;

    const token = { aborted: false };
    activeStart = token;

    await doStart(token);
  }

  async function doStart(token) {
    if (token.aborted) return;
    transition('starting');

    try {
      const audioUrl = await extractAudioUrl(currentUrl, token);
      if (token.aborted) return;

      ffmpegProc = spawnFfmpeg(audioUrl);

      // Give ffmpeg a moment to connect to Icecast, then check it's alive
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (token.aborted) return;

      if (ffmpegProc && ffmpegProc.exitCode === null) {
        transition('streaming');
        retryCount = 0;
      }
      // If ffmpeg already died, the 'close' handler will trigger scheduleRetry()
    } catch (err) {
      if (token.aborted) return;
      logger.error({ err: err.message }, 'failed to start stream');
      scheduleRetry();
    } finally {
      if (activeStart === token) activeStart = null;
    }
  }

  function scheduleRetry() {
    if (retryCount >= MAX_RETRIES) {
      logger.error({ retries: retryCount }, 'max retries exhausted');
      transition('stopped');
      return;
    }

    const delay = BACKOFF[Math.min(retryCount, BACKOFF.length - 1)];
    retryCount++;
    transition('retrying');

    const gen = generation;

    logger.info({ delay, attempt: retryCount, maxRetries: MAX_RETRIES, gen }, 'scheduling retry');

    retryTimer = setTimeout(async () => {
      if (generation !== gen) return; // cancelled by stop or new start
      if (state !== 'retrying') return;
      const retryToken = { aborted: false };
      try {
        const audioUrl = await extractAudioUrl(currentUrl, retryToken);
        if (retryToken.ytdlpProc) pendingYtdlp = retryToken.ytdlpProc;
        if (generation !== gen || state !== 'retrying') return;
        pendingYtdlp = null;
        ffmpegProc = spawnFfmpeg(audioUrl);

        await new Promise(resolve => setTimeout(resolve, 2000));
        if (ffmpegProc && ffmpegProc.exitCode === null) {
          transition('streaming');
          retryCount = 0;
        }
      } catch (err) {
        logger.error({ err: err.message, attempt: retryCount }, 'retry failed');
        scheduleRetry();
      }
    }, delay);
  }

  async function stop() {
    if (state === 'idle' || state === 'stopped') return;
    if (activeStart) {
      activeStart.aborted = true;
      if (activeStart.ytdlpProc) activeStart.ytdlpProc.kill('SIGKILL');
      activeStart = null;
    }
    killFfmpeg();
    transition('stopped');
  }

  function checkTtl(listeners, icecastReachable) {
    if (state !== 'streaming') return;
    if (config.streamTtlMinutes === 0) return;

    // If Icecast is unreachable, we can't know the real listener count.
    // Don't kill the stream — assume listeners are still present.
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

  // --- Persistence ---

  async function persist() {
    try {
      const tmp = STATE_FILE + '.tmp';
      await writeFile(tmp, JSON.stringify({ youtube_url: currentUrl, state }));
      await rename(tmp, STATE_FILE);
    } catch (err) {
      logger.error({ err: err.message }, 'failed to persist state');
    }
  }

  async function loadPersistedState() {
    try {
      const data = await readFile(STATE_FILE, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // --- Startup resume ---

  setImmediate(async () => {
    const saved = await loadPersistedState();
    if (saved && saved.youtube_url && (saved.state === 'streaming' || saved.state === 'starting')) {
      logger.info({ url: saved.youtube_url }, 'resuming stream from saved state');
      start(saved.youtube_url);
    }
  });

  return {
    start,
    stop,
    getState,
    checkTtl,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

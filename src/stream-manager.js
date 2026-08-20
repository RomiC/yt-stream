import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const VALID_TRANSITIONS = {
  idle: ['starting'],
  starting: ['streaming', 'stopped'],
  streaming: ['stopped', 'starting'],
  stopped: ['starting'],
};

const MOUNTPOINT_TIMEOUT = 30_000; // streamlink open + ffmpeg connecting to Icecast

function redactProxy(proxy) {
  try {
    const u = new URL(proxy);
    // Redact when either a username or a password is present (a password-only
    // URL, e.g. http://:pass@host:port, has an empty username but must still
    // be stripped before logging).
    return u.username || u.password ? `${u.protocol}//${u.host}` : proxy;
  } catch {
    return proxy;
  }
}

export function createStreamManager({ logger, config, icecast, proxyList }) {
  const emitter = new EventEmitter();

  let state = 'idle';
  let currentUrl = null;
  let ffmpegProc = null;
  let streamlinkProc = null;
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

  /**
   * Spawns streamlink (fetches YouTube live through a proxy, writes raw media
   * to stdout) piped into ffmpeg (transcodes to MP3 and pushes to Icecast).
   * ffmpeg reads from stdin, so it never touches YouTube's HLS directly.
   */
  function spawnPipeline(youtubeUrl, proxy) {
    const icecastUrl = `icecast://source:${config.icecast.sourcePassword}@${config.icecast.host}:${config.icecast.port}/stream`;

    const streamlinkArgs = [
      '--default-stream', config.streamlinkQuality,
      '--retry-open', '3',
      '--output', '-',
    ];
    if (proxy) streamlinkArgs.push('--http-proxy', proxy);
    streamlinkArgs.push(youtubeUrl);

    const ffmpegArgs = [
      '-i', '-',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-content_type', 'audio/mpeg',
      '-f', 'mp3',
      icecastUrl,
    ];

    const slProc = spawn('streamlink', streamlinkArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    // ffmpeg reads streamlink's output from its stdin, so stdin must be a pipe.
    const ffProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });

    slProc.stdout.pipe(ffProc.stdin);
    streamlinkProc = slProc;
    ffmpegProc = ffProc;

    let slErrTail = '';
    slProc.stderr.on('data', d => {
      const s = d.toString();
      slErrTail = (slErrTail + s).slice(-2000);
      logger.debug({ streamlink: s.trim() });
    });
    slProc.on('error', err => logger.error({ err: err.message }, 'streamlink spawn error'));
    slProc.on('close', code => {
      logger.warn({ code, pid: slProc.pid }, 'streamlink exited');
      if (streamlinkProc === slProc) streamlinkProc = null;
    });

    ffProc.stderr.on('data', d => logger.debug({ ffmpeg: d.toString().trim() }));
    ffProc.on('close', code => {
      logger.warn({ code, pid: ffProc.pid }, 'ffmpeg exited');
      if (ffmpegProc === ffProc) {
        ffmpegProc = null;
        if (state === 'streaming') transition('stopped');
      }
    });
    ffProc.on('error', err => {
      logger.error({ err: err.message }, 'ffmpeg spawn error');
      if (ffmpegProc === ffProc) {
        ffmpegProc = null;
        if (state === 'streaming') transition('stopped');
      }
    });

    return { ffProc, getError: () => slErrTail };
  }

  // SIGTERM, then SIGKILL if it hasn't exited within 5s.
  function killProcess(proc) {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 5000);
  }

  function killPipeline() {
    if (streamlinkProc) {
      const p = streamlinkProc;
      streamlinkProc = null;
      killProcess(p);
    }
    if (ffmpegProc) {
      const p = ffmpegProc;
      ffmpegProc = null;
      killProcess(p);
    }
  }

  async function start(youtubeUrl) {
    // Idempotent: same URL already streaming — no-op
    if (currentUrl === youtubeUrl && state === 'streaming') {
      return;
    }

    // Stop current pipeline if running. sawInactive tracks whether we have
    // observed the /stream mountpoint drop, so the readiness check below never
    // mistakes a lingering OLD source for the newly spawned pipeline.
    let sawInactive = true;
    if (state !== 'idle' && state !== 'stopped') {
      killPipeline();
      sawInactive = false;
      // Wait for the old source to fully disconnect from Icecast so the
      // mountpoint is released before the new source tries to claim it.
      await withTimeout((async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const s = await icecast.pollNow();
          // Only a confirmed (reachable) poll showing the mount inactive
          // counts as cleared — a failed poll reports mountpointActive=false
          // even though the old source may still be connected.
          if (s.icecastReachable && !s.mountpointActive) {
            sawInactive = true;
            return;
          }
          await sleep(500);
        }
        logger.warn('old mountpoint still active after 10s, proceeding anyway');
      })(), 10_000);
    }

    currentUrl = youtubeUrl;
    idleSince = null;
    transition('starting');

    // Pick one proxy from the user-provided list (if any) for this stream.
    const proxies = await proxyList.listProxies();
    const proxy = proxies.length > 0
      ? proxies[Math.floor(Math.random() * proxies.length)]
      : null;
    logger.info({ proxy: proxy ? redactProxy(proxy) : null }, 'starting streamlink pipeline');

    const pipeline = spawnPipeline(youtubeUrl, proxy);

    try {
      // Wait until the Icecast mountpoint is actually active (streamlink
      // opened the stream, ffmpeg is pushing audio).
      await withTimeout((async () => {
        const deadline = Date.now() + MOUNTPOINT_TIMEOUT;
        while (Date.now() < deadline) {
          if (!ffmpegProc) {
            throw new Error(
              `pipeline exited before connecting to Icecast${pipeline.getError() ? `: ${pipeline.getError().split('\n').slice(-3).join(' | ')}` : ''}`,
            );
          }
          const s = await icecast.pollNow();
          if (s.mountpointActive) {
            // Only accept the mountpoint if we have seen it drop first —
            // otherwise it may still be the previous source holding /stream.
            if (sawInactive) {
              transition('streaming');
              return;
            }
          } else if (s.icecastReachable) {
            // Confirmed inactive (not a failed poll) — the next active
            // reading is our new source.
            sawInactive = true;
          }
          await sleep(500);
        }
        throw new Error('mountpoint never became active');
      })(), MOUNTPOINT_TIMEOUT);
    } catch (err) {
      logger.error({ err: err.message }, 'failed to start stream');
      killPipeline();
      transition('stopped');
      throw err;
    }
  }

  async function stop() {
    if (state === 'idle' || state === 'stopped') return;
    killPipeline();
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
      killPipeline();
      transition('stopped');
      return;
    }

    if (config.streamTtlMinutes === 0) return;
    if (!iceStatus.icecastReachable) return;

    if (iceStatus.listeners === 0) {
      if (!idleSince) idleSince = Date.now();
      else if (Date.now() - idleSince >= config.streamTtlMinutes * 60_000) {
        logger.info({ ttlMinutes: config.streamTtlMinutes }, 'TTL expired, stopping stream');
        killPipeline();
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

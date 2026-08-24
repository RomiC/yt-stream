import { Streamlink } from './streamlink.js';
import { Event } from './events.js';
import { Ffmpeg } from './ffmpeg.js';
import { Icecast } from './icecast.js';
import { TTLWatcher } from './ttlWatcher.js';

/**
 * Orchestrates a single stream: streamlink → ffmpeg → Icecast.
 *
 * No state machine — the state is a plain in-memory object (`current`) and
 * control flow is sequential `async/await`. Background concerns (TTL,
 * process exits) are handled through the event bus: TTLWatcher emits
 * `ttl:expired`, process wrappers emit `process:exited`.
 *
 * `current` = null (idle) or
 *   { url, phase: 'starting'|'streaming'|'stopped', startedAt }
 */
export class Stream {
  #logger;
  #icecast;
  #streamlink;
  #ffmpeg;
  #events;
  #current = null;
  #lastUrl = null;
  #ttlWatcher;

  constructor({ config, logger, events }) {
    this.#logger = logger;
    this.#events = events;
    // The stream service owns its collaborators and can report its own
    // health; nothing outside Stream needs them.
    this.#icecast = new Icecast({ config, logger });
    this.#streamlink = new Streamlink({ config, logger, events });
    this.#ffmpeg = new Ffmpeg({ logger, events });
    this.#ttlWatcher = new TTLWatcher({ config, logger, events, icecast: this.#icecast });

    // React to unexpected process exits. Deliberate kills never emit — the
    // wrappers swallow closes of processes we killed ourselves.
    this.#events.on(Event.processExited, () => this.#onProcessExited());

    // TTLWatcher stops itself on expiry and emits `ttl:expired`; Stream
    // reacts by tearing down the pipeline.
    this.#events.on(Event.ttlExpired, () => this.#onTtlExpired());
  }

  /**
   * Kills both processes. When a `reason` is given (a genuine stop) and the
   * stream is still streaming, also marks it stopped and emits
   * stream:stopped — the phase guard makes the stop idempotent across races
   * (a late process-exit or TTL event after a manual stop won't emit twice).
   * The replace/failure paths call it without a reason to just tear down
   * silently.
   */
  async #stopPipeline(reason) {
    await this.#streamlink.kill();
    await this.#ffmpeg.kill();
    if (reason && this.#current?.phase === 'streaming') {
      this.#current.phase = 'stopped';
      this.#current.startedAt = null;
      this.#events.emit(Event.streamStopped, { reason, url: this.#current.url });
    }
  }

  async #onProcessExited() {
    // The pipeline is broken regardless of which process died — tear it
    // down. The wrapper already logged the exit details; the phase guard in
    // #stopPipeline dedupes against a manual stop racing the exit event.
    await this.#stopPipeline('process-exit');
    this.#ttlWatcher.stop();
  }

  async #onTtlExpired() {
    await this.#stopPipeline('ttl');
  }

  /**
   * Start (or replace) a stream for a YouTube URL. Throws on failure — the
   * HTTP layer maps that to a 500. No hidden retries.
   */
  async start(youtubeUrl) {
    if (this.#current && this.#current.phase === 'streaming' && this.#current.url === youtubeUrl) {
      return; // same URL already streaming
    }

    this.#lastUrl = youtubeUrl;

    const replacing = Boolean(this.#current);
    if (replacing) {
      await this.#stopPipeline();
      this.#ttlWatcher.stop();
    }

    try {
      // Stop any existing pipeline, confirm Icecast is ready and the mount is
      // free (old source released), then spawn the pipeline: streamlink
      // proves it opened the stream (picking its own proxy from config),
      // ffmpeg is spawned knowing nothing about the source, Stream pipes the
      // two and waits for the mountpoint.
      await this.#icecast.prepareMountPoint();
      this.#current = {
        url: youtubeUrl,
        phase: 'starting',
        startedAt: null
      };

      const streamlink = await this.#streamlink.spawnProcess(youtubeUrl);
      const ffmpeg = await this.#ffmpeg.spawnProcess(this.#icecast.sourceUrl);
      streamlink.pipe(ffmpeg);
      await this.#icecast.waitForMountpoint();

      this.#current.phase = 'streaming';
      this.#current.startedAt = Date.now();
      this.#ttlWatcher.watch(youtubeUrl);
      this.#events.emit(Event.streamStarted, { url: youtubeUrl });
    } catch (err) {
      this.#logger.error({ err: err.message }, 'failed to start stream');
      await this.#stopPipeline();
      this.#ttlWatcher.stop();
      this.#current = null;
      this.#events.emit(Event.streamError, { url: youtubeUrl, error: err.message });
      throw err;
    }
  }

  async stop() {
    if (!this.#current) {
      return;
    }
    await this.#stopPipeline('manual');
    this.#ttlWatcher.stop();
  }

  /**
   * Public audio mount URL the client is redirected to after a successful
   * start (proxied to Icecast, which owns the mount).
   */
  get streamUrl() {
    return this.#icecast.streamUrl;
  }

  /**
   * Fetches the current state and builds the snapshot for /health: each
   * process's liveness, Icecast availability/state, and the general stream
   * state + URL. Independent of the TTL watcher.
   */
  async getStatus() {
    const icecastStatus = await this.#icecast.pollNow();
    return {
      streamlink: { status: this.#streamlink.isAlive() ? 'running' : 'stopped' },
      ffmpeg: { status: this.#ffmpeg.isAlive() ? 'running' : 'stopped' },
      icecast: {
        status: icecastStatus.icecastReachable ? 'available' : 'unavailable',
        state: icecastStatus.mountpointActive ? 'streaming' : 'stopped'
      },
      general: {
        state: this.#current ? this.#current.phase : 'idle',
        url: this.#current?.url ?? this.#lastUrl ?? null
      }
    };
  }
}

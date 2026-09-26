import { Event } from './events.js';
import { IcecastClient } from './icecastClient.js';
import { StreamPipeline } from './streamPipeline.js';
import { describeExit } from './utils/describeExit.js';
import { getYoutubeMeta } from './utils/getYoutubeMeta.js';

/**
 * Orchestrates the pipeline: streamlink → ffmpeg → Icecast.
 *
 * No state machine — the active generation is a StreamPipeline held in
 * `#current` (live pipelines live in `#pipelines`, keyed by id; a stepping
 * stone to multi-stream). Control flow is sequential async/await; background
 * concerns (process exits, TTL) are observed directly per pipeline. The bus
 * carries only outward stream:* notifications; the shared logger is passed
 * to collaborators that report their own facts (pipeline attempts, Icecast polls).
 */
export class Stream {
  #logger;
  #icecast;
  #events;
  #pipelineId = 0;
  #pipelineOptions;
  #pipelines = new Map();
  // Sets whose teardown has been accounted — a repeated teardown (e.g. a late
  // process-exit after a manual stop) must not emit stream:stopped twice.
  #finalizedSets = new WeakSet();
  #currentPipeline = null;
  #lastUrl = null;

  constructor({ config, logger, events, proxies }) {
    this.#logger = logger;
    this.#events = events;
    this.#pipelineOptions = {
      streamlinkQuality: config.streamlinkQuality,
      streamTtlMinutes: config.streamTtlMinutes,
      proxies
    };
    this.#icecast = new IcecastClient({
      host: config.icecast.host,
      port: config.icecast.port,
      sourcePassword: config.icecast.sourcePassword,
      adminPassword: config.icecast.adminPassword,
      publicBaseUrl: config.publicBaseUrl,
      logger
    });
  }

  #createPipeline(url) {
    const pipeline = new StreamPipeline({
      id: ++this.#pipelineId,
      url,
      ...this.#pipelineOptions,
      icecast: this.#icecast,
      logger: this.#logger
    });
    pipeline.onExit((exit) => this.#onProcessExited(pipeline, exit));
    pipeline.onExpired(() => this.#onTtlExpired(pipeline));
    this.#pipelines.set(pipeline.id, pipeline);
    return pipeline;
  }

  #discardPipeline(set) {
    this.#pipelines.delete(set.id);
  }

  /**
   * Tears down `set` (its own processes), removes it from the live-pipelines
   * map, and — only if it is still the current stream and was streaming —
   * emits stream:stopped. Liveness is judged by hasStarted: a crashed
   * process already reads as phase 'stopped', so isStreaming() would swallow
   * the stop event for the very crashes it reports. Finalized sets are
   * skipped — their stop event has been accounted (or was never eligible).
   */
  async #stopPipeline(set = this.#currentPipeline, reason) {
    if (!set || this.#finalizedSets.has(set)) {
      return;
    }
    // Captured before stop(): mid-await a concurrent teardown (TTL racing a
    // replace) must still see the live set.
    const isLiveStream = set.hasStarted;
    await set.stop();
    this.#finalizedSets.add(set);
    this.#discardPipeline(set);
    if (this.#currentPipeline === set && isLiveStream) {
      this.#currentPipeline = null;
      this.#events.emit(Event.streamStopped, { reason, url: set.url });
    }
  }

  async #onProcessExited(set, exit) {
    // Mid-start exits are owned by the start retry loop (rotation + attribution).
    if (!set.hasStarted) {
      return;
    }
    const { how, tail } = describeExit(exit);
    this.#logger.error({ cmd: exit.cmd, exit: how, tail }, 'unexpected process exit');
    await this.#stopPipeline(set, 'process-exit');
  }

  async #onTtlExpired(set) {
    await this.#stopPipeline(set, 'ttl');
  }

  /**
   * Start (or replace) a stream for a YouTube URL. Throws on failure — the
   * HTTP layer maps that to a 500. No hidden retries.
   */
  async start(youtubeUrl) {
    if (this.#currentPipeline && this.#currentPipeline.isStreaming() && this.#currentPipeline.url === youtubeUrl) {
      return; // same URL already streaming
    }

    this.#lastUrl = youtubeUrl;

    if (this.#currentPipeline) {
      const old = this.#currentPipeline;
      await this.#stopPipeline(old, 'replaced');
    }

    try {
      await this.#icecast.prepareMountPoint();
      const pipeline = this.#createPipeline(youtubeUrl);
      this.#currentPipeline = pipeline;

      await pipeline.start(this.#icecast.sourceUrl);
      pipeline.ttlWatcher.watch(youtubeUrl);

      this.#updateMetadata(youtubeUrl);
      this.#events.emit(Event.streamStarted, { url: youtubeUrl });
    } catch (err) {
      this.#logger.error(
        { err: err.message, proxy: this.#currentPipeline?.lastProxy ?? null },
        'failed to start stream'
      );
      const failed = this.#currentPipeline;
      await this.#stopPipeline(failed, 'start-failed');
      this.#currentPipeline = null;
      this.#events.emit(Event.streamError, { url: youtubeUrl, error: err.message });
      throw err;
    }
  }

  async stop() {
    if (!this.#currentPipeline) {
      return;
    }
    const pipeline = this.#currentPipeline;
    // #stopPipeline nulls #current on the emit; /health falls back to #lastUrl.
    await this.#stopPipeline(pipeline, 'manual');
  }

  async #updateMetadata(youtubeUrl) {
    const metadata = await getYoutubeMeta(youtubeUrl);

    this.#logger.info(
      metadata && { title: metadata.title, author_name: metadata.author_name },
      'Stream metadata fetched'
    );

    if (
      metadata &&
      this.#currentPipeline &&
      this.#currentPipeline.phase === 'streaming' &&
      this.#currentPipeline.url === youtubeUrl
    ) {
      const title = `${metadata.author_name} - ${metadata.title}`;

      await this.#icecast.setMetadata(title);
    }
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
   * process's liveness, Icecast availability/state/listener count, and the
   * general stream state + URL. Independent of the TTL watcher.
   */
  async getStatus() {
    const icecastStatus = await this.#icecast.getStatus();
    const hasActivePipeline = !!this.#currentPipeline;
    return {
      ...(hasActivePipeline
        ? this.#currentPipeline.getStatus()
        : { streamlink: { status: 'stopped' }, ffmpeg: { status: 'stopped' } }),
      icecast: {
        status: icecastStatus.icecastReachable ? 'available' : 'unavailable',
        state: icecastStatus.mountpointActive ? 'streaming' : 'stopped',
        listeners: icecastStatus.listeners
      },
      general: {
        state: hasActivePipeline ? this.#currentPipeline.phase : 'idle',
        url: this.#currentPipeline?.url ?? this.#lastUrl ?? null
      }
    };
  }
}

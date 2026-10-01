import { IcecastClient } from './icecastClient';
import { StreamPipeline } from './streamPipeline';
import { describeExit } from './utils/describeExit';
import { getYoutubeMeta } from './utils/getYoutubeMeta';
import { Event } from './events';
import type { EventBus, StreamStopReason } from './events';
import type { ProxyList } from './proxyList';
import type { ProcessExit } from './childProcess';
import type { ProcessStatus, StreamStatus } from './status';
import type { Config, Logger } from 'yt-stream-shared';

export interface StreamOptions {
  config: Config;
  logger: Logger;
  events: EventBus;
  proxies: ProxyList;
}

/**
 * Orchestrates the pipeline: streamlink → ffmpeg → Icecast.
 * The active generation is a StreamPipeline held in `#currentPipeline` (live
 * pipelines live in `#pipelines`, keyed by id; a stepping stone to multi-stream).
 */
export class Stream {
  #logger: Logger;
  #icecast: IcecastClient;
  #events: EventBus;
  #pipelineId = 0;
  #pipelineOptions: { streamlinkQuality: string; streamTtlMinutes: number; proxies: ProxyList };
  #pipelines = new Map<number, StreamPipeline>();
  // Sets whose teardown has been accounted — a repeated teardown (e.g. a late
  // process-exit after a manual stop) must not emit stream:stopped twice.
  #finalizedSets = new WeakSet<StreamPipeline>();
  #currentPipeline: StreamPipeline | null = null;
  #lastUrl: string | null = null;

  constructor({ config, logger, events, proxies }: StreamOptions) {
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

  get streamUrl(): string {
    return this.#icecast.streamUrl;
  }

  async start(youtubeUrl: string): Promise<void> {
    if (this.#currentPipeline?.isStreaming() && this.#currentPipeline.url === youtubeUrl) {
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
        { err: (err as Error).message, proxy: this.#currentPipeline?.lastProxy ?? null },
        'failed to start stream'
      );
      const failed = this.#currentPipeline;
      await this.#stopPipeline(failed, 'start-failed');
      this.#currentPipeline = null;
      this.#events.emit(Event.streamError, { url: youtubeUrl, error: (err as Error).message });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.#currentPipeline) {
      return;
    }
    const pipeline = this.#currentPipeline;
    await this.#stopPipeline(pipeline, 'manual');
  }

  async getStatus(): Promise<StreamStatus> {
    const icecastStatus = await this.#icecast.getStatus();
    const current = this.#currentPipeline;
    const processes: { streamlink: ProcessStatus; ffmpeg: ProcessStatus } = current
      ? current.getStatus()
      : { streamlink: { status: 'stopped' }, ffmpeg: { status: 'stopped' } };

    return {
      ...processes,
      icecast: {
        status: icecastStatus.icecastReachable ? 'available' : 'unavailable',
        state: icecastStatus.mountpointActive ? 'streaming' : 'stopped',
        listeners: icecastStatus.listeners
      },
      general: {
        state: current ? current.phase : 'idle',
        url: current?.url ?? this.#lastUrl ?? null
      }
    };
  }

  #createPipeline(url: string): StreamPipeline {
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

  #discardPipeline(set: StreamPipeline): void {
    this.#pipelines.delete(set.id);
  }

  /**
   * Tears down `set` (its own processes), removes it from the live-pipelines
   * map, and — only if it is still the current stream and was streaming —
   * emits stream:stopped. Finalized sets are skipped.
   */
  async #stopPipeline(set: StreamPipeline | null = this.#currentPipeline, reason: StreamStopReason): Promise<void> {
    if (!set || this.#finalizedSets.has(set)) {
      return;
    }
    const isLiveStream = set.hasStarted;
    await set.stop();
    this.#finalizedSets.add(set);
    this.#discardPipeline(set);
    if (this.#currentPipeline === set && isLiveStream) {
      this.#currentPipeline = null;
      this.#events.emit(Event.streamStopped, { reason, url: set.url });
    }
  }

  async #onProcessExited(set: StreamPipeline, exit: ProcessExit): Promise<void> {
    // Mid-start exits are owned by the start retry loop (rotation + attribution).
    if (!set.hasStarted) {
      return;
    }
    const { how, tail } = describeExit(exit);
    this.#logger.error({ cmd: exit.cmd, exit: how, tail }, 'unexpected process exit');
    await this.#stopPipeline(set, 'process-exit');
  }

  async #onTtlExpired(set: StreamPipeline): Promise<void> {
    await this.#stopPipeline(set, 'ttl');
  }

  async #updateMetadata(youtubeUrl: string): Promise<void> {
    const metadata = await getYoutubeMeta(youtubeUrl);

    this.#logger.info(
      metadata ? { title: metadata.title, author_name: metadata.author_name } : {},
      'Stream metadata fetched'
    );

    if (
      metadata &&
      this.#currentPipeline &&
      this.#currentPipeline.phase === 'streaming' &&
      this.#currentPipeline.url === youtubeUrl
    ) {
      await this.#icecast.setMetadata(`${metadata.author_name} - ${metadata.title}`);
    }
  }
}

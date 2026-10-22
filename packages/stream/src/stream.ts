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

interface ActiveStream {
  id: string;
  pipeline: StreamPipeline;
}

export class Stream {
  #logger: Logger;
  #icecast: IcecastClient;
  #events: EventBus;
  #pipelineOptions: { streamlinkQuality: string; streamTtlMinutes: number; proxies: ProxyList };
  // A late process exit after teardown must not emit stream:stopped twice.
  #finalizedPipelines = new WeakSet<StreamPipeline>();
  #currentStream: ActiveStream | null = null;
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
    if (this.#currentStream?.pipeline.isStreaming() && this.#currentStream.pipeline.url === youtubeUrl) {
      return; // same URL already streaming
    }

    this.#lastUrl = youtubeUrl;

    if (this.#currentStream) {
      await this.#stopStream(this.#currentStream, 'replaced');
    }

    const id = crypto.randomUUID();
    try {
      await this.#icecast.prepareMountPoint();
      const stream = this.#createStream(youtubeUrl, id);
      this.#currentStream = stream;

      await stream.pipeline.start(this.#icecast.sourceUrl);
      stream.pipeline.ttlWatcher.watch(youtubeUrl);

      this.#updateMetadata(youtubeUrl);
      this.#logger.info({ id, url: youtubeUrl }, 'stream started');
      this.#events.emit(Event.streamStarted, { id });
    } catch (err) {
      this.#logger.error(
        {
          id,
          url: youtubeUrl,
          err: (err as Error).message,
          proxy: this.#currentStream?.pipeline.lastProxy ?? null
        },
        'failed to start stream'
      );
      await this.#stopStream(this.#currentStream, 'start-failed');
      this.#currentStream = null;
      this.#events.emit(Event.streamError, { id, error: (err as Error).message });
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.#stopStream(this.#currentStream, 'manual');
  }

  async getStatus(): Promise<StreamStatus> {
    const icecastStatus = await this.#icecast.getStatus();
    const current = this.#currentStream?.pipeline ?? null;
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

  #createStream(url: string, id: string): ActiveStream {
    const pipeline = new StreamPipeline({
      url,
      ...this.#pipelineOptions,
      icecast: this.#icecast,
      logger: this.#logger
    });
    const stream = { id, pipeline };
    pipeline.onExit((exit) => this.#onProcessExited(stream, exit));
    pipeline.onExpired(() => this.#stopStream(stream, 'ttl'));
    return stream;
  }

  async #stopStream(stream: ActiveStream | null, reason: StreamStopReason): Promise<void> {
    if (!stream || this.#finalizedPipelines.has(stream.pipeline)) {
      return;
    }
    const { id, pipeline } = stream;
    const isLiveStream = pipeline.hasStarted;
    await pipeline.stop();
    this.#finalizedPipelines.add(pipeline);
    if (this.#currentStream === stream && isLiveStream) {
      this.#currentStream = null;
      this.#logger.info({ id, url: pipeline.url, reason }, 'stream stopped');
      this.#events.emit(Event.streamStopped, { id, reason });
    }
  }

  async #onProcessExited(stream: ActiveStream, exit: ProcessExit): Promise<void> {
    // Mid-start exits are owned by the start retry loop (rotation + attribution).
    if (!stream.pipeline.hasStarted) {
      return;
    }
    const { how, tail } = describeExit(exit);
    this.#logger.error(
      { id: stream.id, url: stream.pipeline.url, cmd: exit.cmd, exit: how, tail },
      'unexpected process exit'
    );
    await this.#stopStream(stream, 'process-exit');
  }

  async #updateMetadata(youtubeUrl: string): Promise<void> {
    const metadata = await getYoutubeMeta(youtubeUrl);

    this.#logger.info(
      metadata ? { title: metadata.title, author_name: metadata.author_name } : {},
      'Stream metadata fetched'
    );

    if (
      metadata &&
      this.#currentStream &&
      this.#currentStream.pipeline.phase === 'streaming' &&
      this.#currentStream.pipeline.url === youtubeUrl
    ) {
      await this.#icecast.setMetadata(`${metadata.author_name} - ${metadata.title}`);
    }
  }
}

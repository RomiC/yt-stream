import { IcecastClient } from './icecastClient';
import { StreamPipeline } from './streamPipeline';
import { Event } from './events';
import { describeExit } from './utils/describeExit';
import { getYoutubeMeta } from './utils/getYoutubeMeta';
import type { EventBus, StreamIdentity, StreamStopReason } from './events';
import type { StreamOptions } from './stream';
import type { Logger } from 'yt-stream-shared';

export interface RegisteredStream {
  readonly id: string;
  readonly videoId: string;
  readonly url: string;
  readonly mountpoint: string;
  readonly streamUrl: string;
}

interface RegistryEntry {
  stream: RegisteredStream;
  pipeline: StreamPipeline;
  icecast: IcecastClient;
  logger: Logger;
  controller: AbortController;
  startup: Promise<void>;
  cleanup: Promise<void> | null;
  announced: boolean;
}

export class StreamStartupCancelledError extends Error {
  constructor() {
    super('Stream startup cancelled');
    this.name = 'StreamStartupCancelledError';
  }
}

export class StreamRegistry {
  #options: StreamOptions;
  #events: EventBus;
  #entries = new Map<string, RegistryEntry>();
  #videos = new Map<string, RegistryEntry>();

  constructor(options: StreamOptions) {
    this.#options = options;
    this.#events = options.events;
  }

  get(id: string): RegisteredStream | null {
    return this.#entries.get(id)?.stream ?? null;
  }

  findByVideoId(videoId: string): RegisteredStream | null {
    const entry = this.#videos.get(videoId);
    return entry ? this.get(entry.stream.id) : null;
  }

  async create(videoId: string): Promise<RegisteredStream> {
    if (this.#videos.has(videoId)) {
      throw new Error('Video already registered or cleaning up');
    }

    const id = crypto.randomUUID();
    const identity: StreamIdentity = { id, videoId };
    const logger = this.#streamLogger(identity);
    const { config, proxies } = this.#options;
    const mountpoint = `/stream/${id}`;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const icecast = new IcecastClient({
      ...config.icecast,
      publicBaseUrl: config.publicBaseUrl,
      mountpoint,
      logger
    });
    const pipeline = new StreamPipeline({
      url,
      streamlinkQuality: config.streamlinkQuality,
      streamTtlMinutes: config.streamTtlMinutes,
      proxies,
      icecast,
      logger
    });
    const entry: RegistryEntry = {
      stream: Object.freeze({ id, videoId, url, mountpoint, streamUrl: icecast.streamUrl }),
      pipeline,
      icecast,
      logger,
      controller: new AbortController(),
      startup: Promise.resolve(),
      cleanup: null,
      announced: false
    };
    pipeline.onExit((exit) => {
      if (!entry.announced || !this.#isActive(entry)) {
        return;
      }
      const { how, tail } = describeExit(exit);
      logger.error({ cmd: exit.cmd, exit: how, tail, pid: exit.pid }, 'unexpected process exit');
      void this.#remove(entry, 'process-exit').catch(() => {});
    });
    pipeline.onExpired(() => {
      if (entry.announced && this.#isActive(entry)) {
        void this.#remove(entry, 'ttl').catch(() => {});
      }
    });
    this.#entries.set(id, entry);
    this.#videos.set(videoId, entry);
    entry.startup = Promise.resolve().then(() => this.#start(entry));

    try {
      await entry.startup;
      entry.controller.signal.throwIfAborted();
      return entry.stream;
    } catch (error) {
      await this.#remove(entry, 'start-failed', error);
      throw error;
    }
  }

  async stop(id: string): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (!entry) {
      return false;
    }
    await this.#remove(entry, 'manual');
    return true;
  }

  async #start(entry: RegistryEntry): Promise<void> {
    const signal = entry.controller.signal;
    signal.throwIfAborted();
    await entry.icecast.prepareMountPoint();
    signal.throwIfAborted();
    await entry.pipeline.start(entry.icecast.sourceUrl, signal);
    signal.throwIfAborted();
    if (!entry.pipeline.isStreaming()) {
      throw new Error('Pipeline exited before startup completed');
    }
    entry.pipeline.ttlWatcher.watch(entry.stream.url);
    entry.announced = true;
    entry.logger.info({ url: entry.stream.url }, 'stream started');
    this.#events.emit(Event.streamStarted, { id: entry.stream.id });
    void this.#updateMetadata(entry);
  }

  #remove(entry: RegistryEntry, reason: Exclude<StreamStopReason, 'replaced'>, error?: unknown): Promise<void> {
    if (entry.cleanup) {
      return entry.cleanup;
    }
    this.#entries.delete(entry.stream.id);
    entry.controller.abort(new StreamStartupCancelledError());
    entry.logger.info({ reason }, 'stream removed');

    // Wait for raw startup, not create(): its error handler joins this same cleanup.
    entry.cleanup = Promise.resolve().then(async () => {
      try {
        await entry.pipeline.stop();
        await entry.startup.catch(() => {});
        if (this.#videos.get(entry.stream.videoId) === entry) {
          this.#videos.delete(entry.stream.videoId);
        }
        const id = entry.stream.id;
        if (reason === 'start-failed') {
          const message = error instanceof Error ? error.message : String(error);
          entry.logger.error({ reason, err: message, proxy: entry.pipeline.lastProxy }, 'failed to start stream');
          this.#events.emit(Event.streamError, { id, error: message });
        } else {
          entry.logger.info({ reason }, 'stream stopped');
          this.#events.emit(Event.streamStopped, { id, reason });
        }
      } catch (cleanupError) {
        entry.logger.error({ reason, err: String(cleanupError) }, 'stream cleanup failed');
        throw cleanupError;
      }
    });
    return entry.cleanup;
  }

  #isActive(entry: RegistryEntry): boolean {
    return this.#entries.get(entry.stream.id) === entry;
  }

  #streamLogger(identity: StreamIdentity): Logger {
    const logger = this.#options.logger;
    return Object.fromEntries(
      (['debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => [
        level,
        (fields: Record<string, unknown> | string, message?: string) => {
          logger[level](
            { ...(typeof fields === 'string' ? {} : fields), ...identity },
            typeof fields === 'string' ? fields : message
          );
        }
      ])
    ) as unknown as Logger;
  }

  async #updateMetadata(entry: RegistryEntry): Promise<void> {
    try {
      const metadata = await getYoutubeMeta(entry.stream.url);
      if (metadata && this.#isActive(entry) && entry.pipeline.isStreaming()) {
        await entry.icecast.setMetadata(`${metadata.author_name} - ${metadata.title}`);
      }
    } catch (error) {
      entry.logger.warn({ err: String(error) }, 'stream metadata update failed');
    }
  }
}

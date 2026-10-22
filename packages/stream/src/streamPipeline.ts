import { IcecastUnreachableError } from './icecastClient';
import { Ffmpeg } from './ffmpeg';
import { Streamlink } from './streamlink';
import { TTLWatcher } from './ttlWatcher';
import { describeExit } from './utils/describeExit';
import { redactProxy } from './utils/redactProxy';
import type { ProcessExit } from './childProcess';
import type { IcecastProbe, ProcessStatus, StreamPhase } from './status';
import type { Logger } from 'yt-stream-shared';

const MOUNTPOINT_TIMEOUT = 30_000;
const POLL_INTERVAL = 500;
const START_ATTEMPTS = 3;

export interface PipelineIcecast {
  getStatus(): Promise<IcecastProbe>;
  prepareMountPoint(): Promise<void>;
}

export interface PipelineProxies {
  pickProxies(): Generator<string | null>;
}

export interface StreamPipelineOptions {
  url: string;
  streamlinkQuality: string;
  proxies: PipelineProxies;
  streamTtlMinutes: number;
  icecast: PipelineIcecast;
  logger: Logger;
}

export class StreamPipeline {
  #url: string;
  #startedAt: number | null = null;
  #streamlink: Streamlink | null = null;
  #ffmpeg: Ffmpeg | null = null;
  #ttlWatcher: TTLWatcher;
  #icecast: PipelineIcecast;
  #streamlinkQuality: string;
  #proxies: PipelineProxies;
  #logger: Logger;
  #ready = false;
  #lastProxy: string | null = null;
  #exitCallbacks: ((exit: ProcessExit) => void)[] = [];
  #lastExit: ProcessExit | null = null;

  constructor({ url, streamlinkQuality, proxies, streamTtlMinutes, icecast, logger }: StreamPipelineOptions) {
    this.#url = url;
    this.#streamlinkQuality = streamlinkQuality;
    this.#proxies = proxies;
    this.#logger = logger;
    this.#ttlWatcher = new TTLWatcher({ streamTtlMinutes, icecast });
    this.#icecast = icecast;
  }

  get url(): string {
    return this.#url;
  }

  get startedAt(): number | null {
    return this.#startedAt;
  }

  get phase(): StreamPhase {
    if (!this.#streamlink?.isAlive() || !this.#ffmpeg?.isAlive()) {
      return 'stopped';
    }
    return this.#ready ? 'streaming' : 'starting';
  }

  get streamlink(): Streamlink | null {
    return this.#streamlink;
  }

  get ffmpeg(): Ffmpeg | null {
    return this.#ffmpeg;
  }

  get ttlWatcher(): TTLWatcher {
    return this.#ttlWatcher;
  }

  get lastProxy(): string | null {
    return this.#lastProxy;
  }

  get hasStarted(): boolean {
    return this.#startedAt !== null;
  }

  onExit(callback: (exit: ProcessExit) => void): void {
    this.#exitCallbacks.push(callback);
  }

  onExpired(callback: (payload: { url: string | null }) => void): void {
    this.#ttlWatcher.onExpired(callback);
  }

  isStreaming(): boolean {
    return this.phase === 'streaming';
  }

  async start(sourceUrl: string, signal?: AbortSignal): Promise<void> {
    this.#ready = false;
    const proxyRotation = this.#proxies.pickProxies();
    let lastError: unknown;
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      try {
        await this.#startAttempt(sourceUrl, attempt, proxyRotation.next().value ?? null, signal);
        signal?.throwIfAborted();
        this.#ready = true;
        this.#startedAt = Date.now();
        return;
      } catch (err) {
        lastError = err;
        await this.#killProcesses();
        signal?.throwIfAborted();
        if (attempt < START_ATTEMPTS) {
          await this.#icecast.prepareMountPoint();
        }
      }
    }
    throw lastError;
  }

  async stop(): Promise<void> {
    this.#ttlWatcher.stop();
    await this.#killProcesses();
  }

  getStatus(): { streamlink: ProcessStatus; ffmpeg: ProcessStatus } {
    return {
      streamlink: { status: this.#streamlink?.isAlive() ? 'running' : 'stopped' },
      ffmpeg: { status: this.#ffmpeg?.isAlive() ? 'running' : 'stopped' }
    };
  }

  async #startAttempt(sourceUrl: string, attempt: number, proxy: string | null, signal?: AbortSignal): Promise<void> {
    this.#lastExit = null;
    this.#lastProxy = proxy ? redactProxy(proxy) : null;
    this.#logger.info({ attempt, maxAttempts: START_ATTEMPTS, proxy: this.#lastProxy }, 'starting streamlink');
    this.#streamlink = new Streamlink({ streamlinkQuality: this.#streamlinkQuality })
      .onExit((exit) => this.#onWrapperExit(exit))
      .spawnProcess(this.#url, proxy);
    this.#ffmpeg = new Ffmpeg().onExit((exit) => this.#onWrapperExit(exit)).spawnProcess(sourceUrl);
    this.#streamlink.pipe(this.#ffmpeg);
    await this.#waitReady(signal);
  }

  async #killProcesses(): Promise<void> {
    await Promise.all([this.#streamlink?.kill() ?? false, this.#ffmpeg?.kill() ?? false]);
  }

  async #waitReady(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + MOUNTPOINT_TIMEOUT;
    while (true) {
      signal?.throwIfAborted();
      if (!this.#streamlink?.isAlive() || !this.#ffmpeg?.isAlive()) {
        throw this.#exitError(this.#lastExit);
      }
      const status = await this.#icecast.getStatus();
      if (!status.icecastReachable) {
        throw new IcecastUnreachableError();
      }
      if (status.mountpointActive) {
        // A child may have exited while the status request was in flight.
        if (!this.#streamlink?.isAlive() || !this.#ffmpeg?.isAlive()) {
          throw this.#exitError(this.#lastExit);
        }
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('mountpoint never became active');
      }
      await sleep(Math.min(POLL_INTERVAL, deadline - Date.now()));
    }
  }

  #onWrapperExit(exit: ProcessExit): void {
    this.#lastExit = exit;
    for (const callback of this.#exitCallbacks) {
      callback(exit);
    }
  }

  #exitError(exit: ProcessExit | null): Error {
    const { how, tail } = describeExit(exit!);
    return new Error(`${exit!.cmd} exited before the mountpoint became active (${how})${tail ? `: ${tail}` : ''}`);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

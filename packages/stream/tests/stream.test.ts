import { beforeAll, beforeEach, describe, expect, mock, test, vi } from 'bun:test';
import { Event, EventBus } from '../src/events';
import { flushAsync, silentLogger, sleep } from './helpers';
import type { ProcessExit } from '../src/childProcess';
import type { Config, Logger } from 'yt-stream-shared';

const URL_UNDER_TEST = 'https://youtube.com/watch?v=abc';
const SOURCE_URL = 'icecast://source:testsource@icecast:8000/stream';
const MOUNT_URL = 'http://localhost:8000/stream';

let icecastInstances: FakeIcecast[] = [];
let pipelineInstances: FakeStreamPipeline[] = [];
let StreamPipelineFake: typeof FakeStreamPipeline;
let Stream: typeof import('../src/stream').Stream;
let youtubeMeta: Promise<unknown> = Promise.resolve(null);
const getYoutubeMetaFake = vi.fn<(url: string) => Promise<unknown>>(() => youtubeMeta);

class FakeIcecast {
  status = { icecastReachable: true, mountpointActive: true, listeners: 0 };
  setMetadata = vi.fn<(title: string) => Promise<boolean>>(() => Promise.resolve(true));

  constructor() {
    icecastInstances.push(this);
  }

  async prepareMountPoint(): Promise<void> {}
  async getStatus() {
    return { ...this.status };
  }
  get sourceUrl(): string {
    return SOURCE_URL;
  }
  get streamUrl(): string {
    return MOUNT_URL;
  }
}

class FakeStreamPipeline {
  static next: Record<string, unknown> | null = null;
  exitCallbacks: ((exit: ProcessExit) => void)[] = [];
  expiredCallbacks: (() => void)[] = [];
  startCalls: string[] = [];
  stopCalls = 0;
  id: number;
  url: string;
  phase = 'idle';
  hasStarted = false;
  lastProxy: string | null = null;
  startError: Error | null = null;
  ttlWatcher: { watched: string[]; stops: number; watch: (url: string) => void; stop: () => void };

  constructor(options: { id: number; url: string }) {
    this.id = options.id;
    this.url = options.url;
    this.ttlWatcher = {
      watched: [],
      stops: 0,
      watch: (url: string) => this.ttlWatcher.watched.push(url),
      stop: () => {
        this.ttlWatcher.stops += 1;
      }
    };
    Object.assign(this, FakeStreamPipeline.next ?? {});
    FakeStreamPipeline.next = null;
    pipelineInstances.push(this);
  }

  async start(sourceUrl: string): Promise<void> {
    this.startCalls.push(sourceUrl);
    if (this.startError) {
      throw this.startError;
    }
    this.hasStarted = true;
    this.phase = 'streaming';
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.phase = 'idle';
    this.ttlWatcher.stops += 1;
  }

  isStreaming(): boolean {
    return this.phase === 'streaming';
  }

  onExit(callback: (exit: ProcessExit) => void): void {
    this.exitCallbacks.push(callback);
  }

  onExpired(callback: () => void): void {
    this.expiredCallbacks.push(callback);
  }

  die(exit: ProcessExit = { cmd: 'streamlink', code: 1, signal: null, pid: 4242, errors: '' }): void {
    for (const callback of this.exitCallbacks) {
      callback(exit);
    }
  }

  expire(): void {
    for (const callback of this.expiredCallbacks) {
      callback();
    }
  }

  getStatus() {
    const status = this.phase === 'streaming' ? 'running' : 'stopped';
    return { streamlink: { status }, ffmpeg: { status } };
  }
}

function captureLogger() {
  const entries: Record<string, unknown>[] = [];
  const record =
    (level: string) =>
    (fields: string | Record<string, unknown>, message?: string): void => {
      entries.push(typeof fields === 'string' ? { level, msg: fields } : { level, ...fields, msg: message });
    };
  const logger = {
    entries,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal')
  };
  return logger;
}

beforeAll(async () => {
  mock.module('../src/icecastClient', () => ({ IcecastClient: FakeIcecast }));
  mock.module('../src/streamPipeline', () => ({ StreamPipeline: FakeStreamPipeline }));
  mock.module('../src/utils/getYoutubeMeta', () => ({ getYoutubeMeta: getYoutubeMetaFake }));
  StreamPipelineFake = FakeStreamPipeline;
  ({ Stream } = await import('../src/stream'));
});

beforeEach(() => {
  youtubeMeta = Promise.resolve(null);
  getYoutubeMetaFake.mockClear();
});

function createStream(logger: Logger = silentLogger()) {
  icecastInstances = [];
  pipelineInstances = [];
  const events = new EventBus();
  const stream = new Stream({
    config: {
      streamTtlMinutes: 15,
      streamlinkQuality: 'audio_only,worst',
      icecast: { host: 'icecast', port: 8000, sourcePassword: 'testsource', adminPassword: 'testadmin' },
      publicBaseUrl: 'http://localhost'
    } as unknown as Config,
    proxies: {} as never,
    logger,
    events
  });

  return {
    stream,
    events,
    get icecast() {
      return icecastInstances.at(-1)!;
    },
    get pipeline() {
      return pipelineInstances.at(-1)!;
    }
  };
}

describe('Stream', () => {
  describe('start', () => {
    test('happy path: prepares, starts the pipeline, watches TTL, emits stream:started', async () => {
      const app = createStream();
      const onStarted = vi.fn();
      app.events.on(Event.streamStarted, onStarted);

      await app.stream.start(URL_UNDER_TEST);

      expect(app.pipeline.startCalls).toEqual([SOURCE_URL]);
      expect(app.pipeline.ttlWatcher.watched).toEqual([URL_UNDER_TEST]);
      expect(onStarted.mock.calls.length).toBe(1);
      expect(onStarted.mock.calls[0][0]).toEqual({ url: URL_UNDER_TEST });
      expect((await app.stream.getStatus()).general.state).toBe('streaming');
    });

    test('idempotent: starting the same URL again is a no-op', async () => {
      const app = createStream();

      await app.stream.start(URL_UNDER_TEST);
      await app.stream.start(URL_UNDER_TEST);

      expect(pipelineInstances.length).toBe(1);
      expect(app.pipeline.startCalls.length).toBe(1);
    });

    test('should fetch youtube meta and post to icecast', async () => {
      const { promise: youtubeMetaPromise, resolve: resolveYoutubeMetaPromise } = Promise.withResolvers<unknown>();
      youtubeMeta = youtubeMetaPromise;

      const app = createStream();
      const onStarted = vi.fn();
      app.events.on(Event.streamStarted, onStarted);

      const startPromise = app.stream.start(URL_UNDER_TEST);

      await sleep(0);

      expect(getYoutubeMetaFake.mock.calls.length).toBe(1);
      expect(getYoutubeMetaFake.mock.calls[0][0]).toBe(URL_UNDER_TEST);

      resolveYoutubeMetaPromise({ title: 'lofi hip-hop', author_name: 'LoFi Girl' });

      await sleep(0);

      expect(app.icecast.setMetadata.mock.calls.length).toBe(1);
      expect(app.icecast.setMetadata.mock.calls[0][0]).toBe('LoFi Girl - lofi hip-hop');

      await startPromise;
    });

    test('fail fast: unreachable Icecast rejects before any pipeline is created', async () => {
      const app = createStream();
      const onError = vi.fn();
      app.events.on(Event.streamError, onError);
      app.icecast.prepareMountPoint = async () => {
        throw new Error('Icecast unreachable — cannot start stream');
      };

      await expect(app.stream.start(URL_UNDER_TEST)).rejects.toThrow(/Icecast unreachable/);

      expect(pipelineInstances.length).toBe(0);
      expect(onError.mock.calls.length).toBe(1);
      expect((await app.stream.getStatus()).general.state).toBe('idle');
    });

    test('a pipeline start failure is torn down, reported, and rethrown', async () => {
      const app = createStream();
      const onError = vi.fn();
      app.events.on(Event.streamError, onError);
      StreamPipelineFake.next = { startError: new Error('streamlink exited before the mountpoint became active') };

      await expect(app.stream.start(URL_UNDER_TEST)).rejects.toThrow(/streamlink exited/);

      expect(app.pipeline.stopCalls).toBe(1);
      expect(onError.mock.calls.length).toBe(1);
      expect((onError.mock.calls[0][0] as { url: string }).url).toBe(URL_UNDER_TEST);
      expect((await app.stream.getStatus()).general.state).toBe('idle');
    });

    test('a failed start logs the proxy the pipeline picked', async () => {
      const logger = captureLogger();
      const app = createStream(logger as unknown as Logger);
      StreamPipelineFake.next = {
        lastProxy: 'http://proxy:3128',
        startError: new Error('streamlink exited before the mountpoint became active')
      };

      await expect(app.stream.start(URL_UNDER_TEST)).rejects.toThrow(/streamlink exited/);

      const failure = logger.entries.find((entry) => entry.msg === 'failed to start stream');
      expect(failure?.level).toBe('error');
      expect(failure?.proxy).toBe('http://proxy:3128');
    });

    test('replacing a stream: records the old one as replaced, then starts anew', async () => {
      const app = createStream();
      const order: string[] = [];
      app.events.on(Event.streamStarted, ({ url }) => order.push(`started:${url.slice(-3)}`));
      app.events.on(Event.streamStopped, ({ url, reason }) => order.push(`stopped:${url.slice(-3)}:${reason}`));
      const prepare = vi.fn(async () => {});
      app.icecast.prepareMountPoint = prepare;

      await app.stream.start('https://youtube.com/watch?v=abc');
      await app.stream.start('https://youtube.com/watch?v=def');

      expect(order).toEqual(['started:abc', 'stopped:abc:replaced', 'started:def']);
      expect(prepare.mock.calls.length).toBe(2);
      expect(pipelineInstances.length).toBe(2);
      expect(pipelineInstances[0].stopCalls).toBe(1);
      expect(pipelineInstances[0].ttlWatcher.watched).toEqual(['https://youtube.com/watch?v=abc']);
      expect(pipelineInstances[0].ttlWatcher.stops).toBe(1);
      const status = await app.stream.getStatus();
      expect(status.general.state).toBe('streaming');
      expect(status.general.url).toBe('https://youtube.com/watch?v=def');
    });

    test('failed replace: the old stream is recorded as replaced, the new one as an error', async () => {
      const app = createStream();
      const onStopped = vi.fn();
      const onError = vi.fn();
      app.events.on(Event.streamStopped, onStopped);
      app.events.on(Event.streamError, onError);

      await app.stream.start('https://youtube.com/watch?v=abc');

      app.icecast.prepareMountPoint = async () => {
        throw new Error('old source still connected to the mountpoint');
      };
      await expect(app.stream.start('https://youtube.com/watch?v=def')).rejects.toThrow(/old source still connected/);

      expect(onStopped.mock.calls.length).toBe(1);
      expect(onStopped.mock.calls[0][0]).toEqual({ reason: 'replaced', url: 'https://youtube.com/watch?v=abc' });
      expect(onError.mock.calls.length).toBe(1);
      expect((onError.mock.calls[0][0] as { url: string }).url).toBe('https://youtube.com/watch?v=def');
      expect((await app.stream.getStatus()).general.state).toBe('idle');
    });
  });

  describe('streamUrl', () => {
    test('streamUrl proxies the Icecast mount URL', () => {
      expect(createStream().stream.streamUrl).toBe(MOUNT_URL);
    });
  });

  describe('stop', () => {
    test('stop() emits stream:stopped with reason manual and stops the TTL watcher', async () => {
      const app = createStream();
      const onStopped = vi.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL_UNDER_TEST);
      await app.stream.stop();

      expect(onStopped.mock.calls.length).toBe(1);
      expect(onStopped.mock.calls[0][0]).toEqual({ reason: 'manual', url: URL_UNDER_TEST });
      expect(app.pipeline.stopCalls).toBe(1);
      expect(app.pipeline.ttlWatcher.stops).toBe(1);
      expect((await app.stream.getStatus()).general.state).toBe('idle');
    });

    test('stop() on idle is a no-op', async () => {
      const app = createStream();
      await app.stream.stop();

      expect(pipelineInstances.length).toBe(0);
      expect((await app.stream.getStatus()).general.state).toBe('idle');
    });
  });

  describe('events', () => {
    test('unexpected process exit emits stream:stopped with reason process-exit', async () => {
      const app = createStream();
      const onStopped = vi.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL_UNDER_TEST);
      app.pipeline.die();
      await flushAsync();

      expect(onStopped.mock.calls.length).toBe(1);
      expect(onStopped.mock.calls[0][0]).toEqual({ reason: 'process-exit', url: URL_UNDER_TEST });
      expect(app.pipeline.ttlWatcher.stops).toBe(1);
    });

    test('TTL expiry stops the stream with reason ttl', async () => {
      const app = createStream();
      const onStopped = vi.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL_UNDER_TEST);
      app.pipeline.expire();
      await flushAsync();

      expect(onStopped.mock.calls.length).toBe(1);
      expect(onStopped.mock.calls[0][0]).toEqual({ reason: 'ttl', url: URL_UNDER_TEST });
    });

    test('a stale TTL teardown does not stop a replacement stream', async () => {
      const app = createStream();
      const onStopped = vi.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL_UNDER_TEST);

      let releaseStop: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const stopped = pipelineInstances[0].stop.bind(pipelineInstances[0]);
      let first = true;
      pipelineInstances[0].stop = async () => {
        if (first) {
          first = false;
          await gate;
        }
        return stopped();
      };
      pipelineInstances[0].expire();

      await app.stream.start('https://youtube.com/watch?v=def');
      releaseStop();
      await flushAsync();

      const status = await app.stream.getStatus();
      expect(status.general.state).toBe('streaming');
      expect(status.general.url).toBe('https://youtube.com/watch?v=def');
      expect(onStopped.mock.calls.filter((call) => (call[0] as { reason: string }).reason === 'ttl').length).toBe(0);
      expect(pipelineInstances.at(-1)!.stopCalls).toBe(0);
    });

    test('a pipe cascade (both processes dying) emits exactly one stream:stopped', async () => {
      const app = createStream();
      const onStopped = vi.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL_UNDER_TEST);
      app.pipeline.die({ cmd: 'streamlink', code: 1, signal: null, pid: 4242, errors: '' });
      app.pipeline.die({ cmd: 'ffmpeg', code: 1, signal: null, pid: 4243, errors: '' });
      await flushAsync();

      expect(onStopped.mock.calls.length).toBe(1);
      expect(onStopped.mock.calls[0][0]).toEqual({ reason: 'process-exit', url: URL_UNDER_TEST });
      expect((await app.stream.getStatus()).general.state).toBe('idle');
    });

    test('a late process-exit after a manual stop does not emit stream:stopped twice', async () => {
      const app = createStream();
      const onStopped = vi.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL_UNDER_TEST);
      await app.stream.stop();
      app.pipeline.die();
      await flushAsync();

      expect(onStopped.mock.calls.length).toBe(1);
    });
  });

  describe('getStatus', () => {
    test('getStatus reports the full snapshot', async () => {
      const app = createStream();
      app.icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 3 };

      const status = await app.stream.getStatus();

      expect(status).toEqual({
        streamlink: { status: 'stopped' },
        ffmpeg: { status: 'stopped' },
        icecast: { status: 'available', state: 'streaming', listeners: 3 },
        general: { state: 'idle', url: null }
      });
    });

    test('getStatus reports unavailable Icecast', async () => {
      const app = createStream();
      app.icecast.status = { icecastReachable: false, mountpointActive: false, listeners: 0 };

      const status = await app.stream.getStatus();
      expect(status.icecast.status).toBe('unavailable');
      expect(status.icecast.state).toBe('stopped');
      expect(status.icecast.listeners).toBe(0);
    });

    test('getStatus while streaming includes running processes and the URL', async () => {
      const app = createStream();
      app.icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 2 };

      await app.stream.start(URL_UNDER_TEST);

      const status = await app.stream.getStatus();
      expect(status.streamlink.status).toBe('running');
      expect(status.ffmpeg.status).toBe('running');
      expect(status.icecast.state).toBe('streaming');
      expect(status.icecast.listeners).toBe(2);
      expect(status.general.state).toBe('streaming');
      expect(status.general.url).toBe(URL_UNDER_TEST);
    });

    test('getStatus remembers the last URL after a stop', async () => {
      const app = createStream();
      await app.stream.start(URL_UNDER_TEST);
      await app.stream.stop();

      const status = await app.stream.getStatus();
      expect(status.general.state).toBe('idle');
      expect(status.general.url).toBe(URL_UNDER_TEST);
      expect(app.pipeline.ttlWatcher.stops).toBe(1);
    });
  });
});

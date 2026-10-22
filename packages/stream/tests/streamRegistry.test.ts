import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Config } from 'yt-stream-shared';
import { Event, EventBus } from '../src/events';
import { flushAsync } from './helpers';
import type { Logger } from 'yt-stream-shared';
import type { ProcessExit } from '../src/childProcess';
import type { IcecastClientOptions } from '../src/icecastClient';
import type { StreamPipelineOptions } from '../src/streamPipeline';
import type { ProxyList } from '../src/proxyList';
import type { YoutubeMeta } from '../src/utils/getYoutubeMeta';

const VIDEO_A = 'r_SV26dPwuA';
const VIDEO_B = 'abcdefghijk';
const urlFor = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
const exit: ProcessExit = { cmd: 'ffmpeg', code: null, signal: 'SIGKILL', pid: 4242, errors: 'stderr tail' };

let StreamRegistry: typeof import('../src/streamRegistry').StreamRegistry;
let StreamStartupCancelledError: typeof import('../src/streamRegistry').StreamStartupCancelledError;
let icecasts: FakeIcecast[] = [];
let pipelines: FakePipeline[] = [];
const metadata = mock<(url: string) => Promise<YoutubeMeta | null>>(async () => null);

class FakeIcecast {
  static next: Partial<FakeIcecast> = {};
  prepareGate = Promise.resolve();
  prepareMountPoint = mock(() => this.prepareGate);
  setMetadata = mock(async (_title: string) => true);
  getStatus = mock(async () => ({ icecastReachable: true, mountpointActive: true, listeners: 0 }));
  options: IcecastClientOptions;

  constructor(options: IcecastClientOptions) {
    this.options = options;
    Object.assign(this, FakeIcecast.next);
    FakeIcecast.next = {};
    icecasts.push(this);
  }

  get sourceUrl() {
    return `icecast://source:testsource@icecast:8080${this.options.mountpoint}`;
  }

  get streamUrl() {
    return `${this.options.publicBaseUrl}${this.options.mountpoint}`;
  }
}

class FakePipeline {
  static next: Partial<FakePipeline> = {};
  options: StreamPipelineOptions;
  hasStarted = false;
  running = false;
  startGate = Promise.resolve();
  stopGate = Promise.resolve();
  lastProxy: string | null = null;
  exitCallbacks: ((exit: ProcessExit) => void)[] = [];
  expiredCallbacks: (() => void)[] = [];
  ttlWatcher = { watch: mock((_url: string) => {}), stop: mock(() => {}) };
  start = mock(async (_sourceUrl: string, signal?: AbortSignal) => {
    await this.startGate;
    signal?.throwIfAborted();
    this.hasStarted = true;
    this.running = true;
  });
  stop = mock(async () => {
    this.ttlWatcher.stop();
    await this.stopGate;
    this.running = false;
  });

  constructor(options: StreamPipelineOptions) {
    this.options = options;
    Object.assign(this, FakePipeline.next);
    FakePipeline.next = {};
    pipelines.push(this);
  }

  isStreaming() {
    return this.running;
  }

  onExit(callback: (exit: ProcessExit) => void) {
    this.exitCallbacks.push(callback);
  }

  onExpired(callback: () => void) {
    this.expiredCallbacks.push(callback);
  }

  die() {
    this.running = false;
    for (const callback of this.exitCallbacks) {
      callback(exit);
    }
  }

  expire() {
    for (const callback of this.expiredCallbacks) {
      callback();
    }
  }
}

beforeAll(async () => {
  mock.module('../src/icecastClient', () => ({ IcecastClient: FakeIcecast }));
  mock.module('../src/streamPipeline', () => ({ StreamPipeline: FakePipeline }));
  mock.module('../src/utils/getYoutubeMeta', () => ({ getYoutubeMeta: metadata }));
  ({ StreamRegistry, StreamStartupCancelledError } = await import('../src/streamRegistry'));
});

beforeEach(() => {
  icecasts = [];
  pipelines = [];
  FakeIcecast.next = {};
  FakePipeline.next = {};
  metadata.mockReset();
  metadata.mockImplementation(async () => null);
});

function setup() {
  const logs: Record<string, unknown>[] = [];
  const logger = Object.fromEntries(
    (['debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => [
      level,
      (fields: Record<string, unknown> | string, message?: string) => {
        logs.push({ level, ...(typeof fields === 'string' ? {} : fields), msg: message ?? fields });
      }
    ])
  ) as unknown as Logger;
  const events = new EventBus();
  const started = mock();
  const stopped = mock();
  const errors = mock();
  events.on(Event.streamStarted, started);
  events.on(Event.streamStopped, stopped);
  events.on(Event.streamError, errors);
  const proxies = {} as ProxyList;
  const registry = new StreamRegistry({
    config: new Config({ PUBLIC_BASE_URL: 'https://yts.example.com', STREAM_TTL_MINUTES: '20' }),
    logger,
    events,
    proxies
  });
  return { registry, events, logs, started, stopped, errors, proxies };
}

describe('StreamRegistry', () => {
  test('creates independent UUID mounts and configures each pipeline with its own client', async () => {
    const { registry, started, proxies } = setup();
    const [first, second] = await Promise.all([registry.create(VIDEO_A), registry.create(VIDEO_B)]);
    expect(first.id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(second.id).not.toBe(first.id);
    expect(first.id).not.toBe(VIDEO_A);
    expect(first).toEqual({
      id: first.id,
      videoId: VIDEO_A,
      url: urlFor(VIDEO_A),
      mountpoint: `/stream/${first.id}`,
      streamUrl: `https://yts.example.com/stream/${first.id}`
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(pipelines[0]).not.toBe(pipelines[1]);
    for (const [index, stream] of [first, second].entries()) {
      const pipeline = pipelines[index];
      expect(pipeline.options).not.toHaveProperty('id');
      expect(pipeline.options.icecast).toBe(icecasts[index]);
      expect(pipeline.options.proxies).toBe(proxies);
      expect(pipeline.options.streamTtlMinutes).toBe(20);
      expect(pipeline.start.mock.calls[0][0]).toBe(icecasts[index].sourceUrl);
      expect(pipeline.ttlWatcher.watch).toHaveBeenCalledWith(stream.url);
      expect(icecasts[index].options.mountpoint).toBe(stream.mountpoint);
      expect(started.mock.calls[index][0]).toEqual({ id: stream.id });
    }
  });

  test('registers identity before asynchronous work without blocking other videos', async () => {
    const gate = Promise.withResolvers<void>();
    FakeIcecast.next = { prepareGate: gate.promise };
    const { registry, started } = setup();
    const pending = registry.create(VIDEO_A);
    const identity = registry.findByVideoId(VIDEO_A)!;
    expect(registry.get(identity.id)).toBe(identity);
    expect(started).not.toHaveBeenCalled();
    const second = await registry.create(VIDEO_B);
    expect(registry.get(second.id)).toBe(second);
    expect(pipelines[0].start).not.toHaveBeenCalled();
    gate.resolve();
    expect(await pending).toBe(identity);
  });

  test('rejects duplicate creation without joining or spawning duplicate pipelines', async () => {
    const gate = Promise.withResolvers<void>();
    FakeIcecast.next = { prepareGate: gate.promise };
    const { registry } = setup();
    const pending = registry.create(VIDEO_A);
    await expect(registry.create(VIDEO_A)).rejects.toThrow('Video already registered or cleaning up');
    gate.resolve();
    await pending;
    await expect(registry.create(VIDEO_A)).rejects.toThrow('Video already registered or cleaning up');
    expect(pipelines).toHaveLength(1);
  });

  test('treats case-distinct video IDs independently', async () => {
    const { registry } = setup();
    const [first, second] = await Promise.all([registry.create(VIDEO_A), registry.create(VIDEO_A.toLowerCase())]);
    expect(first.id).not.toBe(second.id);
    expect(registry.findByVideoId(VIDEO_A)).toBe(first);
    expect(registry.findByVideoId(VIDEO_A.toLowerCase())).toBe(second);
  });

  test('hides a stopping entry immediately, but keeps its video reserved until cleanup', async () => {
    const { registry, stopped } = setup();
    const [first, second] = await Promise.all([registry.create(VIDEO_A), registry.create(VIDEO_B)]);
    const gate = Promise.withResolvers<void>();
    pipelines[0].stopGate = gate.promise;
    const stopping = registry.stop(first.id);
    expect(registry.get(first.id)).toBeNull();
    expect(registry.findByVideoId(VIDEO_A)).toBeNull();
    expect(registry.get(second.id)).toBe(second);
    expect(await registry.stop(first.id)).toBe(false);
    await expect(registry.create(VIDEO_A)).rejects.toThrow('cleaning up');
    expect(stopped).not.toHaveBeenCalled();
    gate.resolve();
    expect(await stopping).toBe(true);
    const next = await registry.create(VIDEO_A);
    expect(next.id).not.toBe(first.id);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls[0][0]).toEqual({ id: first.id, reason: 'manual' });
    expect(pipelines[1].stop).not.toHaveBeenCalled();
  });

  test('does not retain public history across stops or new registries', async () => {
    const { registry } = setup();
    const stream = await registry.create(VIDEO_A);
    await registry.stop(stream.id);
    expect(registry.get(stream.id)).toBeNull();
    expect(registry.findByVideoId(VIDEO_A)).toBeNull();
    expect(setup().registry.get(stream.id)).toBeNull();
    expect(await registry.stop('unknown')).toBe(false);
  });

  test('preparation failure removes only its own entry and emits one error', async () => {
    FakeIcecast.next = {
      prepareMountPoint: mock(async () => {
        throw new Error('Icecast unreachable');
      })
    };
    const { registry, started, errors } = setup();
    const failed = registry.create(VIDEO_A).catch((error: Error) => error);
    const id = registry.findByVideoId(VIDEO_A)!.id;
    const second = await registry.create(VIDEO_B);
    expect(await failed).toMatchObject({ message: 'Icecast unreachable' });
    expect(registry.get(id)).toBeNull();
    expect(registry.get(second.id)).toBe(second);
    expect(pipelines[0].start).not.toHaveBeenCalled();
    expect(pipelines[0].stop).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toEqual({ id, error: 'Icecast unreachable' });
    expect(started).toHaveBeenCalledTimes(1);
    await registry.create(VIDEO_A);
  });

  test('startup failure stays hidden while cleanup runs and preserves error attribution', async () => {
    const cleanup = Promise.withResolvers<void>();
    FakePipeline.next = {
      start: mock(async () => {
        throw new Error('extraction failed');
      }),
      stopGate: cleanup.promise,
      lastProxy: 'http://proxy:3128'
    };
    const { registry, logs, started, errors } = setup();
    const outcome = registry.create(VIDEO_A).catch((error: Error) => error);
    const id = registry.findByVideoId(VIDEO_A)!.id;
    await flushAsync();
    expect(registry.get(id)).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    await expect(registry.create(VIDEO_A)).rejects.toThrow('cleaning up');
    cleanup.resolve();
    expect(await outcome).toMatchObject({ message: 'extraction failed' });
    expect(started).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(logs.find((log) => log.msg === 'failed to start stream')).toMatchObject({
      id,
      videoId: VIDEO_A,
      reason: 'start-failed',
      proxy: 'http://proxy:3128',
      err: 'extraction failed'
    });
  });

  test('stopping before startup executes never prepares or spawns', async () => {
    const { registry, started, stopped, errors } = setup();
    const outcome = registry.create(VIDEO_A).catch((error: Error) => error);
    const id = registry.findByVideoId(VIDEO_A)!.id;
    await registry.stop(id);
    expect(await outcome).toBeInstanceOf(StreamStartupCancelledError);
    expect(icecasts[0].prepareMountPoint).not.toHaveBeenCalled();
    expect(pipelines[0].start).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  test('stopping during mount preparation cannot spawn a pipeline later', async () => {
    const gate = Promise.withResolvers<void>();
    FakeIcecast.next = { prepareGate: gate.promise };
    const { registry, started } = setup();
    const outcome = registry.create(VIDEO_A).catch((error: Error) => error);
    const id = registry.findByVideoId(VIDEO_A)!.id;
    await flushAsync();
    const stopping = registry.stop(id);
    expect(registry.get(id)).toBeNull();
    gate.resolve();
    await stopping;
    expect(await outcome).toBeInstanceOf(StreamStartupCancelledError);
    expect(pipelines[0].start).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  test('late pipeline readiness after removal cannot restart TTL, metadata, or lifecycle events', async () => {
    const gate = Promise.withResolvers<void>();
    FakePipeline.next = { startGate: gate.promise };
    const { registry, started, stopped, errors } = setup();
    const outcome = registry.create(VIDEO_A).catch((error: Error) => error);
    const id = registry.findByVideoId(VIDEO_A)!.id;
    await flushAsync();
    const stopping = registry.stop(id);
    gate.resolve();
    await stopping;
    expect(await outcome).toBeInstanceOf(StreamStartupCancelledError);
    expect(registry.get(id)).toBeNull();
    expect(pipelines[0].ttlWatcher.watch).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  test('removal from a started-event callback cannot return a removed entry to its creator', async () => {
    const { registry, events } = setup();
    events.on(Event.streamStarted, ({ id }) => {
      void registry.stop(id);
    });
    await expect(registry.create(VIDEO_A)).rejects.toBeInstanceOf(StreamStartupCancelledError);
    expect(registry.findByVideoId(VIDEO_A)).toBeNull();
  });

  test('process-exit cascades trigger one teardown and do not affect another video', async () => {
    const { registry, stopped, logs } = setup();
    const [first, second] = await Promise.all([registry.create(VIDEO_A), registry.create(VIDEO_B)]);
    pipelines[0].die();
    pipelines[0].die();
    pipelines[0].expire();
    expect(registry.get(first.id)).toBeNull();
    await flushAsync();
    expect(registry.get(second.id)).toBe(second);
    expect(pipelines[0].stop).toHaveBeenCalledTimes(1);
    expect(pipelines[1].stop).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls[0][0].reason).toBe('process-exit');
    expect(logs.find((log) => log.msg === 'unexpected process exit')).toMatchObject({
      id: first.id,
      videoId: VIDEO_A,
      cmd: 'ffmpeg',
      exit: 'signal SIGKILL',
      tail: 'stderr tail',
      pid: 4242
    });
  });

  test('TTL stops only its owning generation and stale callbacks cannot stop a restart', async () => {
    const { registry, stopped } = setup();
    const [first, second] = await Promise.all([registry.create(VIDEO_A), registry.create(VIDEO_B)]);
    const oldPipeline = pipelines[0];
    oldPipeline.expire();
    expect(registry.get(first.id)).toBeNull();
    await flushAsync();
    const next = await registry.create(VIDEO_A);
    oldPipeline.expire();
    oldPipeline.die();
    await flushAsync();
    expect(registry.get(next.id)).toBe(next);
    expect(registry.get(second.id)).toBe(second);
    expect(pipelines[2].stop).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls[0][0].reason).toBe('ttl');
  });

  test('mid-start process-exit callbacks remain owned by the pipeline retry loop', async () => {
    const gate = Promise.withResolvers<void>();
    FakePipeline.next = { startGate: gate.promise };
    const { registry, stopped } = setup();
    const pending = registry.create(VIDEO_A);
    await flushAsync();
    pipelines[0].die();
    expect(pipelines[0].stop).not.toHaveBeenCalled();
    gate.resolve();
    const stream = await pending;
    expect(registry.get(stream.id)).toBe(stream);
    expect(stopped).not.toHaveBeenCalled();
  });

  test('out-of-order metadata updates target only the corresponding mount', async () => {
    const first = Promise.withResolvers<YoutubeMeta | null>();
    const second = Promise.withResolvers<YoutubeMeta | null>();
    metadata.mockImplementation((url) => (url === urlFor(VIDEO_A) ? first.promise : second.promise));
    const { registry } = setup();
    await Promise.all([registry.create(VIDEO_A), registry.create(VIDEO_B)]);
    second.resolve({ title: 'B', author_name: 'Artist B' });
    first.resolve({ title: 'A', author_name: 'Artist A' });
    await flushAsync();
    expect(icecasts[0].setMetadata).toHaveBeenCalledWith('Artist A - A');
    expect(icecasts[1].setMetadata).toHaveBeenCalledWith('Artist B - B');
  });

  test('metadata fetched for a stopped generation cannot update the restarted stream', async () => {
    const gate = Promise.withResolvers<YoutubeMeta | null>();
    metadata.mockImplementationOnce(() => gate.promise);
    const { registry } = setup();
    const stream = await registry.create(VIDEO_A);
    await registry.stop(stream.id);
    const next = await registry.create(VIDEO_A);
    gate.resolve({ title: 'Old', author_name: 'Artist' });
    await flushAsync();
    expect(registry.get(next.id)).toBe(next);
    expect(icecasts[0].setMetadata).not.toHaveBeenCalled();
    expect(icecasts[1].setMetadata).not.toHaveBeenCalled();
  });

  test('metadata failure is best-effort and never stops playback', async () => {
    metadata.mockImplementation(async () => {
      throw new Error('metadata unavailable');
    });
    const { registry, errors, logs } = setup();
    const stream = await registry.create(VIDEO_A);
    await flushAsync();
    expect(registry.get(stream.id)).toBe(stream);
    expect(pipelines[0].stop).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(logs.find((log) => log.msg === 'stream metadata update failed')).toMatchObject({
      id: stream.id,
      videoId: VIDEO_A
    });
  });

  test('pipeline and Icecast logs carry immutable stream identity', async () => {
    const { registry, logs } = setup();
    const stream = await registry.create(VIDEO_A);
    pipelines[0].options.logger.info({ attempt: 2, id: 'wrong' }, 'attempt');
    icecasts[0].options.logger.warn('poll failure');
    for (const entry of logs) {
      expect(entry).toMatchObject({ id: stream.id, videoId: VIDEO_A });
      expect(entry).not.toHaveProperty('pipelineId');
    }
    expect(logs.find((entry) => entry.msg === 'attempt')?.attempt).toBe(2);
    expect(logs.find((entry) => entry.msg === 'poll failure')?.level).toBe('warn');
  });

  test('cleanup failure hides the entry but retains its internal video reservation', async () => {
    const { registry, stopped, logs } = setup();
    const stream = await registry.create(VIDEO_A);
    pipelines[0].stop = mock(async () => {
      throw new Error('kill failed');
    });
    await expect(registry.stop(stream.id)).rejects.toThrow('kill failed');
    expect(registry.get(stream.id)).toBeNull();
    expect(registry.findByVideoId(VIDEO_A)).toBeNull();
    await expect(registry.create(VIDEO_A)).rejects.toThrow('cleaning up');
    expect(stopped).not.toHaveBeenCalled();
    expect(logs.find((entry) => entry.msg === 'stream cleanup failed')).toMatchObject({
      id: stream.id,
      videoId: VIDEO_A
    });
    await registry.create(VIDEO_B);
  });
});

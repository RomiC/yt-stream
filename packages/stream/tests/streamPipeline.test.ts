import { beforeAll, beforeEach, describe, expect, jest, mock, test, vi } from 'bun:test';
import { silentLogger, flushAsync } from './helpers';
import type { ProcessExit } from '../src/childProcess';
import type { IcecastProbe } from '../src/status';

const URL_UNDER_TEST = 'https://youtube.com/watch?v=abc';
const SOURCE_URL = 'icecast://source:testsource@icecast:8000/stream';

type Probe = IcecastProbe;

let icecast: {
  status: Probe;
  getStatus: () => Promise<Probe>;
  prepareMountPoint: ReturnType<typeof vi.fn>;
};

let streamlinkInstances: FakeStreamlink[] = [];
let ffmpegInstances: FakeFfmpeg[] = [];
let ttlWatcherInstances: FakeTTLWatcher[] = [];
let StreamlinkFake: typeof FakeStreamlink;
let FfmpegFake: typeof FakeFfmpeg;
let StreamPipeline: typeof import('../src/streamPipeline').StreamPipeline;

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

function fakeProxies(entries: string[] = []) {
  return {
    *pickProxies(): Generator<string | null> {
      if (entries.length === 0) {
        yield null;
        return;
      }
      let index = 0;
      while (true) {
        yield entries[Math.min(index++, entries.length - 1)];
      }
    }
  };
}

class FakeTTLWatcher {
  expiredCallbacks: ((payload: { url: string | null }) => void)[] = [];
  stops = 0;

  constructor() {
    ttlWatcherInstances.push(this);
  }

  onExpired(callback: (payload: { url: string | null }) => void): void {
    this.expiredCallbacks.push(callback);
  }

  watch(): void {}

  stop(): void {
    this.stops += 1;
  }
}

class FakeStreamlink {
  static next: Record<string, unknown> | null = null;
  static all: Record<string, unknown> | null = null;
  exitCallbacks: ((exit: ProcessExit) => void)[] = [];
  spawnCalls: { url: string; proxy: string | null }[] = [];
  pipeCalls: unknown[] = [];
  spawned = false;
  errorTail = '';

  constructor() {
    Object.assign(this, FakeStreamlink.all ?? {}, FakeStreamlink.next ?? {});
    FakeStreamlink.next = null;
    streamlinkInstances.push(this);
  }

  onExit(callback: (exit: ProcessExit) => void): this {
    this.exitCallbacks.push(callback);
    return this;
  }

  die(code = 1, signal: string | null = null): void {
    this.spawned = false;
    for (const callback of this.exitCallbacks) {
      callback({ cmd: 'streamlink', code, signal, pid: 4242, errors: this.errorTail });
    }
  }

  spawnProcess(url: string, proxy: string | null = null): this {
    this.spawnCalls.push({ url, proxy });
    this.spawned = true;
    return this;
  }

  pipe(target: unknown): void {
    this.pipeCalls.push(target);
  }

  async kill(): Promise<boolean> {
    this.spawned = false;
    return true;
  }

  isAlive(): boolean {
    return this.spawned;
  }
}

class FakeFfmpeg {
  static next: Record<string, unknown> | null = null;
  static all: Record<string, unknown> | null = null;
  exitCallbacks: ((exit: ProcessExit) => void)[] = [];
  spawnCalls: string[] = [];
  spawned = false;
  errorTail = '';

  constructor() {
    Object.assign(this, FakeFfmpeg.all ?? {}, FakeFfmpeg.next ?? {});
    FfmpegFake.next = null;
    ffmpegInstances.push(this);
  }

  onExit(callback: (exit: ProcessExit) => void): this {
    this.exitCallbacks.push(callback);
    return this;
  }

  die(code: number | null = 1, signal: string | null = null): void {
    this.spawned = false;
    for (const callback of this.exitCallbacks) {
      callback({ cmd: 'ffmpeg', code, signal, pid: 4242, errors: this.errorTail });
    }
  }

  spawnProcess(sourceUrl: string): this {
    this.spawnCalls.push(sourceUrl);
    this.spawned = true;
    return this;
  }

  async kill(): Promise<boolean> {
    this.spawned = false;
    return true;
  }

  isAlive(): boolean {
    return this.spawned;
  }
}

beforeAll(async () => {
  icecast = {
    status: { icecastReachable: true, mountpointActive: true, listeners: 0 },
    getStatus: async () => ({ ...icecast.status }),
    prepareMountPoint: vi.fn(async () => {})
  };

  mock.module('../src/icecastClient', () => ({
    IcecastUnreachableError: class IcecastUnreachableError extends Error {
      constructor() {
        super('Icecast unreachable — cannot start stream');
      }
    }
  }));
  mock.module('../src/streamlink', () => ({ Streamlink: FakeStreamlink }));
  mock.module('../src/ffmpeg', () => ({ Ffmpeg: FakeFfmpeg }));
  mock.module('../src/ttlWatcher', () => ({ TTLWatcher: FakeTTLWatcher }));

  StreamlinkFake = FakeStreamlink;
  FfmpegFake = FakeFfmpeg;
  ({ StreamPipeline } = await import('../src/streamPipeline'));
});

beforeEach(() => {
  icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 0 };
  icecast.getStatus = async () => ({ ...icecast.status });
  icecast.prepareMountPoint.mockClear();
});

async function tickMocked(steps: number, stepMs = 500): Promise<void> {
  for (let step = 0; step < steps; step++) {
    jest.advanceTimersByTime(stepMs);
    await flushAsync();
  }
}

function createPipeline({
  proxies = fakeProxies(),
  logger = silentLogger(),
  onExit
}: {
  proxies?: ReturnType<typeof fakeProxies>;
  logger?: ReturnType<typeof silentLogger>;
  onExit?: (exit: ProcessExit) => void;
} = {}) {
  streamlinkInstances = [];
  ffmpegInstances = [];
  ttlWatcherInstances = [];
  StreamlinkFake.all = null;
  FfmpegFake.all = null;
  const pipeline = new StreamPipeline({
    id: 1,
    url: URL_UNDER_TEST,
    streamlinkQuality: 'audio_only,worst',
    proxies,
    streamTtlMinutes: 15,
    icecast,
    logger
  });
  if (onExit) {
    pipeline.onExit(onExit);
  }
  return pipeline;
}

describe('StreamPipeline', () => {
  describe('start', () => {
    test('spawns a fresh pair, pipes them, and becomes ready', async () => {
      const pipeline = createPipeline();

      await pipeline.start(SOURCE_URL);

      expect((pipeline.streamlink as unknown as FakeStreamlink)?.spawnCalls).toEqual([
        { url: URL_UNDER_TEST, proxy: null }
      ]);
      expect((pipeline.ffmpeg as unknown as FakeFfmpeg)?.spawnCalls).toEqual([SOURCE_URL]);
      expect((pipeline.streamlink as unknown as FakeStreamlink)?.pipeCalls[0]).toBe(pipeline.ffmpeg);
      expect(pipeline.hasStarted).toBe(true);
      expect(pipeline.phase).toBe('streaming');
      expect(pipeline.getStatus()).toEqual({ streamlink: { status: 'running' }, ffmpeg: { status: 'running' } });
    });

    test('rotation: a failed attempt confirms the mount is free before retrying', async () => {
      const pipeline = createPipeline();
      StreamlinkFake.all = {
        spawnProcess: function (this: FakeStreamlink) {
          this.spawned = true;
          this.die();
          return this;
        }
      };

      await expect(pipeline.start(SOURCE_URL)).rejects.toThrow(/streamlink exited/);

      expect(icecast.prepareMountPoint.mock.calls.length).toBe(2);
    });

    test('a child exiting while the mount check is in flight does not pass as ready', async () => {
      const pipeline = createPipeline();
      icecast.getStatus = async () => {
        ffmpegInstances.at(-1)?.die(null, 'SIGKILL');
        return { icecastReachable: true, mountpointActive: true, listeners: 0 };
      };

      await expect(pipeline.start(SOURCE_URL)).rejects.toThrow(
        /ffmpeg exited before the mountpoint became active \(signal SIGKILL\)/
      );
      expect(pipeline.hasStarted).toBe(false);
    });

    test('rotation: a failed attempt retries with a fresh pair and the next proxy', async () => {
      const proxies = fakeProxies(['http://a:3128', 'http://b:3128']);
      const pipeline = createPipeline({ proxies });
      StreamlinkFake.next = {
        spawnProcess: function (this: FakeStreamlink, url: string, proxy: string | null) {
          this.spawnCalls.push({ url, proxy });
          this.spawned = true;
          this.errorTail = 'error: Unable to open URL: 403 Forbidden\n';
          this.die();
          return this;
        }
      };

      await pipeline.start(SOURCE_URL);

      expect(streamlinkInstances.length).toBe(2);
      const picked = streamlinkInstances.flatMap((instance) => instance.spawnCalls.map((call) => call.proxy));
      expect(picked).toEqual(['http://a:3128', 'http://b:3128']);
      expect(pipeline.phase).toBe('streaming');
    });

    test('exhausting all attempts fails the start with attribution', async () => {
      const pipeline = createPipeline();
      StreamlinkFake.all = {
        spawnProcess: function (this: FakeStreamlink) {
          this.spawned = true;
          this.errorTail = 'error: Unable to open URL: 403 Forbidden\n';
          this.die();
          return this;
        }
      };

      await expect(pipeline.start(SOURCE_URL)).rejects.toThrow(
        /streamlink exited before the mountpoint became active \(code 1\): .*403 Forbidden/
      );

      expect(streamlinkInstances.length).toBe(3);
      expect(pipeline.hasStarted).toBe(false);
      expect(pipeline.phase).toBe('stopped');
    });

    test('a mid-start exit is attributed to the dead process, not the killed survivor', async () => {
      const pipeline = createPipeline();
      icecast.status = { icecastReachable: true, mountpointActive: false, listeners: 0 };
      FfmpegFake.all = {
        spawnProcess: function (this: FakeFfmpeg) {
          this.spawned = true;
          this.die(null, 'SIGKILL');
          return this;
        }
      };

      await expect(pipeline.start(SOURCE_URL)).rejects.toThrow(
        /ffmpeg exited before the mountpoint became active \(signal SIGKILL\)/
      );
      expect(pipeline.phase).toBe('stopped');
    });

    test('each attempt logs the redacted proxy', async () => {
      const logger = captureLogger();
      const pipeline = createPipeline({ logger, proxies: fakeProxies(['http://user:secret@proxy:3128']) });
      StreamlinkFake.all = {
        spawnProcess: function (this: FakeStreamlink) {
          this.spawned = true;
          this.die();
          return this;
        }
      };

      await expect(pipeline.start(SOURCE_URL)).rejects.toThrow(/streamlink exited/);

      const attempts = logger.entries.filter((entry) => entry.msg === 'starting streamlink');
      expect(attempts.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
      expect(attempts.every((entry) => entry.proxy === 'http://proxy:3128')).toBe(true);
      expect(pipeline.lastProxy).toBe('http://proxy:3128');
    });

    test('forwards unexpected process exits to onExit subscribers', async () => {
      const exits: ProcessExit[] = [];
      const pipeline = createPipeline({ onExit: (exit) => exits.push(exit) });
      await pipeline.start(SOURCE_URL);

      (pipeline.ffmpeg as unknown as FakeFfmpeg)?.die(null, 'SIGKILL');

      expect(exits.length).toBe(1);
      expect(exits[0].cmd).toBe('ffmpeg');
      expect(exits[0].signal).toBe('SIGKILL');
    });

    test('readiness: keeps polling until the mountpoint becomes active', async () => {
      jest.useFakeTimers();
      const pipeline = createPipeline();
      let calls = 0;
      icecast.getStatus = async () => {
        calls += 1;
        return { icecastReachable: true, mountpointActive: calls >= 3, listeners: 0 };
      };

      const started = pipeline.start(SOURCE_URL);
      await tickMocked(20);
      await started;

      expect(calls >= 3).toBe(true);
      expect(pipeline.phase).toBe('streaming');
      jest.useRealTimers();
    });

    test('readiness: fails when Icecast drops mid-wait', async () => {
      const pipeline = createPipeline();
      icecast.status = { icecastReachable: false, mountpointActive: false, listeners: 0 };

      await expect(pipeline.start(SOURCE_URL)).rejects.toThrow(/Icecast unreachable/);
      expect(pipeline.phase).toBe('stopped');
    });

    test('readiness: times out when the mountpoint never activates and nothing exits', async () => {
      jest.useFakeTimers();
      const pipeline = createPipeline();
      icecast.status = { icecastReachable: true, mountpointActive: false, listeners: 0 };

      let outcome: string | null = null;
      void pipeline.start(SOURCE_URL).then(
        () => {
          outcome = 'resolved';
        },
        (err: Error) => {
          outcome = err.message;
        }
      );

      for (let tick = 0; tick < 500 && outcome === null; tick++) {
        jest.advanceTimersByTime(500);
        await flushAsync();
      }

      expect(outcome).toMatch(/mountpoint never became active/);
      expect(pipeline.phase).toBe('stopped');
      jest.useRealTimers();
    });
  });

  describe('stop', () => {
    test('stops the watcher first, then kills the pair', async () => {
      const pipeline = createPipeline();
      await pipeline.start(SOURCE_URL);

      await pipeline.stop();

      expect((pipeline.ttlWatcher as unknown as FakeTTLWatcher).stops).toBe(1);
      expect(pipeline.phase).toBe('stopped');
      expect(pipeline.streamlink?.isAlive()).toBe(false);
      expect(pipeline.ffmpeg?.isAlive()).toBe(false);
    });

    test('is safe before any start (no pair to kill)', async () => {
      const pipeline = createPipeline();

      await pipeline.stop();

      expect((pipeline.ttlWatcher as unknown as FakeTTLWatcher).stops).toBe(1);
      expect(pipeline.phase).toBe('stopped');
    });
  });
});

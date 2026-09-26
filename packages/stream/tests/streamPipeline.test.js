import { describe, before, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { silentLogger } from './helpers.js';

const URL = 'https://youtube.com/watch?v=abc';
const SOURCE_URL = 'icecast://source:testsource@icecast:8000/stream';

let icecast;
let streamlinkInstances = [];
let ffmpegInstances = [];
let ttlWatcherInstances = [];
let StreamlinkFake;
let FfmpegFake;
let StreamPipeline;

/** Collects (fields, message) pairs per level for log assertions. */
function captureLogger() {
  const entries = [];
  const record = (level) => (fields, message) => {
    entries.push(typeof fields === 'string' ? { level, msg: fields } : { level, ...fields, msg: message });
  };
  const logger = { entries };
  for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
    logger[level] = record(level);
  }
  logger.child = () => logger;
  return logger;
}

/** Stub pool: a per-request iterator handing out the given proxies in order, repeating the last one. */
function fakeProxies(entries = []) {
  return {
    *pickProxies() {
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

before(async (ctx) => {
  icecast = {
    status: { icecastReachable: true, mountpointActive: true, listeners: 0 },
    getStatus: async () => ({ ...icecast.status })
  };

  ctx.mock.module('../src/icecastClient.js', {
    exports: {
      IcecastUnreachableError: class IcecastUnreachableError extends Error {
        constructor() {
          super('Icecast unreachable — cannot start stream');
        }
      }
    }
  });

  class FakeStreamlink {
    static next = null; // applies to the next constructed instance only
    static all = null; // applies to every constructed instance until reset
    exitCallbacks = [];
    spawnCalls = [];
    pipeCalls = [];

    constructor() {
      this.spawned = false;
      Object.assign(this, FakeStreamlink.all ?? {}, FakeStreamlink.next ?? {});
      FakeStreamlink.next = null;
      streamlinkInstances.push(this);
    }

    onExit(callback) {
      this.exitCallbacks.push(callback);
      return this;
    }

    die(code = 1, signal = null) {
      // Matches the real wrapper: liveness flips before close callbacks run.
      this.spawned = false;
      for (const callback of this.exitCallbacks) {
        callback({ cmd: 'streamlink', code, signal, pid: 4242, errors: this.errorTail ?? '' });
      }
    }

    spawnProcess(url, proxy = null) {
      this.spawnCalls.push({ url, proxy });
      this.spawned = true;
      return this;
    }

    pipe(target) {
      this.pipeCalls.push(target);
    }

    async kill() {
      this.spawned = false;
      return true;
    }

    isAlive() {
      return this.spawned;
    }
  }
  StreamlinkFake = FakeStreamlink;
  ctx.mock.module('../src/streamlink.js', { exports: { Streamlink: StreamlinkFake } });

  class FakeFfmpeg {
    static next = null;
    static all = null;
    exitCallbacks = [];
    spawnCalls = [];

    constructor() {
      this.spawned = false;
      Object.assign(this, FfmpegFake.all ?? {}, FfmpegFake.next ?? {});
      FfmpegFake.next = null;
      ffmpegInstances.push(this);
    }

    onExit(callback) {
      this.exitCallbacks.push(callback);
      return this;
    }

    die(code = 1, signal = null) {
      this.spawned = false;
      for (const callback of this.exitCallbacks) {
        callback({ cmd: 'ffmpeg', code, signal, pid: 4242, errors: this.errorTail ?? '' });
      }
    }

    spawnProcess(sourceUrl) {
      this.spawnCalls.push(sourceUrl);
      this.spawned = true;
      return this;
    }

    async kill() {
      this.spawned = false;
      return true;
    }

    isAlive() {
      return this.spawned;
    }
  }
  FfmpegFake = FakeFfmpeg;
  ctx.mock.module('../src/ffmpeg.js', { exports: { Ffmpeg: FfmpegFake } });

  ctx.mock.module('../src/ttlWatcher.js', {
    exports: {
      TTLWatcher: class FakeTTLWatcher {
        expiredCallbacks = [];

        constructor() {
          this.stops = 0;
          ttlWatcherInstances.push(this);
        }

        onExpired(callback) {
          this.expiredCallbacks.push(callback);
        }

        watch() {}

        stop() {
          this.stops += 1;
        }
      }
    }
  });

  ({ StreamPipeline } = await import('../src/streamPipeline.js'));
});

beforeEach(() => {
  icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 0 };
  icecast.getStatus = async () => ({ ...icecast.status });
});

/** Drives a pipeline under mocked timers: our loops await between ticks, so drain microtasks after each. */
async function tickMocked(context, steps, stepMs = 500) {
  for (let step = 0; step < steps; step++) {
    context.mock.timers.tick(stepMs);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Direct pipeline construction — no Stream, no EventBus. */
function createPipeline({ proxies = fakeProxies(), logger = silentLogger(), onExit } = {}) {
  streamlinkInstances = [];
  ffmpegInstances = [];
  ttlWatcherInstances = [];
  StreamlinkFake.all = null;
  FfmpegFake.all = null;
  const pipeline = new StreamPipeline({
    id: 1,
    url: URL,
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

      assert.deepEqual(pipeline.streamlink.spawnCalls, [{ url: URL, proxy: null }]);
      assert.deepEqual(pipeline.ffmpeg.spawnCalls, [SOURCE_URL]);
      assert.equal(pipeline.streamlink.pipeCalls[0], pipeline.ffmpeg);
      assert.equal(pipeline.hasStarted, true);
      assert.equal(pipeline.phase, 'streaming');
      assert.deepEqual(pipeline.getStatus(), {
        streamlink: { status: 'running' },
        ffmpeg: { status: 'running' }
      });
    });

    test('rotation: a failed attempt retries with a fresh pair and the next proxy', async () => {
      const proxies = fakeProxies(['http://a:3128', 'http://b:3128']);
      const pipeline = createPipeline({ proxies });
      StreamlinkFake.next = {
        spawnProcess: function (url, proxy) {
          this.spawnCalls.push({ url, proxy });
          this.spawned = true;
          this.errorTail = 'error: Unable to open URL: 403 Forbidden\n';
          this.die();
          return this;
        }
      };

      await pipeline.start(SOURCE_URL);

      assert.equal(streamlinkInstances.length, 2, 'one fresh streamlink per attempt');
      const picked = streamlinkInstances.flatMap((instance) => instance.spawnCalls.map((call) => call.proxy));
      assert.deepEqual(picked, ['http://a:3128', 'http://b:3128']);
      assert.equal(pipeline.phase, 'streaming');
    });

    test('exhausting all attempts fails the start with attribution', async () => {
      const pipeline = createPipeline();
      StreamlinkFake.all = {
        spawnProcess: function () {
          this.spawned = true;
          this.errorTail = 'error: Unable to open URL: 403 Forbidden\n';
          this.die();
          return this;
        }
      };

      await assert.rejects(
        pipeline.start(SOURCE_URL),
        /streamlink exited before the mountpoint became active \(code 1\): .*403 Forbidden/
      );

      assert.equal(streamlinkInstances.length, 3, 'three attempts, three fresh streamlinks');
      assert.equal(pipeline.hasStarted, false);
      assert.equal(pipeline.phase, 'stopped');
    });

    test('a mid-start exit is attributed to the dead process, not the killed survivor', async () => {
      const pipeline = createPipeline();
      icecast.status = { icecastReachable: true, mountpointActive: false, listeners: 0 };
      FfmpegFake.all = {
        spawnProcess: function () {
          this.spawned = true;
          this.die(null, 'SIGKILL'); // externally killed (OOM-style)
          return this;
        }
      };

      await assert.rejects(
        pipeline.start(SOURCE_URL),
        /ffmpeg exited before the mountpoint became active \(signal SIGKILL\)/
      );
      assert.equal(pipeline.phase, 'stopped');
    });

    test('each attempt logs the redacted proxy', async () => {
      const logger = captureLogger();
      const pipeline = createPipeline({
        logger,
        proxies: fakeProxies(['http://user:secret@proxy:3128'])
      });
      StreamlinkFake.all = {
        spawnProcess: function () {
          this.spawned = true;
          this.die();
          return this;
        }
      };

      await assert.rejects(pipeline.start(SOURCE_URL), /streamlink exited/);

      const attempts = logger.entries.filter((entry) => entry.msg === 'starting streamlink');
      assert.deepEqual(
        attempts.map((entry) => entry.attempt),
        [1, 2, 3]
      );
      assert.ok(attempts.every((entry) => entry.proxy === 'http://proxy:3128'));
      assert.equal(pipeline.lastProxy, 'http://proxy:3128');
    });

    test('forwards unexpected process exits to onExit subscribers', async () => {
      const exits = [];
      const pipeline = createPipeline({ onExit: (exit) => exits.push(exit) });
      await pipeline.start(SOURCE_URL);

      pipeline.ffmpeg.die(null, 'SIGKILL');

      assert.equal(exits.length, 1);
      assert.equal(exits[0].cmd, 'ffmpeg');
      assert.equal(exits[0].signal, 'SIGKILL');
    });

    test('readiness: keeps polling until the mountpoint becomes active', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const pipeline = createPipeline();
      let calls = 0;
      icecast.getStatus = async () => {
        calls += 1;
        return { icecastReachable: true, mountpointActive: calls >= 3, listeners: 0 };
      };

      const started = pipeline.start(SOURCE_URL);
      await tickMocked(context, 20);
      await started;

      assert.ok(calls >= 3);
      assert.equal(pipeline.phase, 'streaming');
    });

    test('readiness: fails when Icecast drops mid-wait', async () => {
      const pipeline = createPipeline();
      icecast.status = { icecastReachable: false, mountpointActive: false, listeners: 0 };

      await assert.rejects(pipeline.start(SOURCE_URL), /Icecast unreachable/);
      assert.equal(pipeline.phase, 'stopped');
    });

    test('readiness: times out when the mountpoint never activates and nothing exits', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const pipeline = createPipeline();
      icecast.status = { icecastReachable: true, mountpointActive: false, listeners: 0 };

      const started = pipeline.start(SOURCE_URL);
      const rejection = assert.rejects(started, /mountpoint never became active/);
      // Three attempts, each burning the 30 s mountpoint budget.
      await tickMocked(context, 200);
      await rejection;

      assert.equal(pipeline.phase, 'stopped');
    });
  });

  describe('stop', () => {
    test('stops the watcher first, then kills the pair', async () => {
      const pipeline = createPipeline();
      await pipeline.start(SOURCE_URL);

      await pipeline.stop();

      assert.equal(pipeline.ttlWatcher.stops, 1);
      assert.equal(pipeline.phase, 'stopped');
      assert.equal(pipeline.streamlink.isAlive(), false);
      assert.equal(pipeline.ffmpeg.isAlive(), false);
    });

    test('is safe before any start (no pair to kill)', async () => {
      const pipeline = createPipeline();

      await pipeline.stop();

      assert.equal(pipeline.ttlWatcher.stops, 1);
      assert.equal(pipeline.phase, 'stopped');
    });
  });
});

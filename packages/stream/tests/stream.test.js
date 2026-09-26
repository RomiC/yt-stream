import { describe, before, test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, Event } from '../src/events.js';
import { silentLogger, flushAsync, sleep } from './helpers.js';

const URL = 'https://youtube.com/watch?v=abc';
const SOURCE_URL = 'icecast://source:testsource@icecast:8000/stream';
const MOUNT_URL = 'http://localhost:8000/stream';

let icecastInstances = [];
let pipelineInstances = [];
let StreamPipelineFake;
let Stream;
let youtubeMeta = Promise.resolve(null);
let getYoutubeMetaFake = mock.fn(() => youtubeMeta);

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

before(async (ctx) => {
  ctx.mock.module('../src/icecastClient.js', {
    exports: {
      IcecastClient: class FakeIcecast {
        constructor() {
          this.status = { icecastReachable: true, mountpointActive: true, listeners: 0 };
          this.setMetadata = mock.fn(() => Promise.resolve(true));
          icecastInstances.push(this);
        }

        async prepareMountPoint() {}
        async getStatus() {
          return { ...this.status };
        }

        get sourceUrl() {
          return SOURCE_URL;
        }

        get streamUrl() {
          return MOUNT_URL;
        }
      }
    }
  });

  class FakeStreamPipeline {
    static next = null; // applies to the next constructed instance only
    exitCallbacks = [];
    expiredCallbacks = [];
    startCalls = [];
    stopCalls = 0;

    constructor(options) {
      this.id = options.id;
      this.url = options.url;
      this.phase = 'idle';
      this.hasStarted = false;
      this.lastProxy = null;
      this.startError = null;
      this.ttlWatcher = {
        watched: [],
        stops: 0,
        watch: (url) => this.ttlWatcher.watched.push(url),
        stop: () => {
          this.ttlWatcher.stops += 1;
        }
      };
      Object.assign(this, FakeStreamPipeline.next ?? {});
      FakeStreamPipeline.next = null;
      pipelineInstances.push(this);
    }

    async start(sourceUrl) {
      this.startCalls.push(sourceUrl);
      if (this.startError) {
        throw this.startError;
      }
      this.hasStarted = true;
      this.phase = 'streaming';
    }

    async stop() {
      this.stopCalls += 1;
      this.phase = 'idle';
      this.ttlWatcher.stops += 1;
    }

    isStreaming() {
      return this.phase === 'streaming';
    }

    onExit(callback) {
      this.exitCallbacks.push(callback);
    }

    onExpired(callback) {
      this.expiredCallbacks.push(callback);
    }

    /** Simulates an unexpected process exit (the payload carries the cmd fact). */
    die(exit = { cmd: 'streamlink', code: 1, signal: null, pid: 4242, errors: '' }) {
      for (const callback of this.exitCallbacks) {
        callback(exit);
      }
    }

    expire() {
      for (const callback of this.expiredCallbacks) {
        callback();
      }
    }

    getStatus() {
      const status = this.phase === 'streaming' ? 'running' : 'stopped';
      return { streamlink: { status }, ffmpeg: { status } };
    }
  }
  StreamPipelineFake = FakeStreamPipeline;
  ctx.mock.module('../src/streamPipeline.js', { exports: { StreamPipeline: StreamPipelineFake } });

  ctx.mock.module('../src/utils/getYoutubeMeta.js', {
    exports: {
      getYoutubeMeta: getYoutubeMetaFake
    }
  });

  ({ Stream } = await import('../src/stream.js'));
});

beforeEach(() => {
  youtubeMeta = Promise.resolve(null);
  getYoutubeMetaFake.mock.resetCalls();
});

/** Builds a Stream with fresh fake pipelines; icecast is a single shared instance. */
function createStream(logger = silentLogger()) {
  icecastInstances = [];
  pipelineInstances = [];
  const events = new EventBus();
  const stream = new Stream({
    config: {
      streamTtlMinutes: 15,
      streamlinkQuality: 'audio_only,worst',
      icecast: {
        host: 'icecast',
        port: 8000,
        sourcePassword: 'testsource',
        adminPassword: 'testadmin'
      },
      publicBaseUrl: 'http://localhost'
    },
    proxies: {},
    logger,
    events
  });
  return {
    stream,
    events,
    get icecast() {
      return icecastInstances.at(-1);
    },
    get pipeline() {
      return pipelineInstances.at(-1);
    }
  };
}

describe('Stream', () => {
  describe('start', () => {
    test('happy path: prepares, starts the pipeline, watches TTL, emits stream:started', async () => {
      const app = createStream();
      const onStarted = mock.fn();
      app.events.on(Event.streamStarted, onStarted);

      await app.stream.start(URL);

      assert.deepEqual(app.pipeline.startCalls, [SOURCE_URL]);
      assert.deepEqual(app.pipeline.ttlWatcher.watched, [URL]);
      assert.equal(onStarted.mock.callCount(), 1);
      assert.deepEqual(onStarted.mock.calls[0].arguments[0], { url: URL });
      assert.equal((await app.stream.getStatus()).general.state, 'streaming');
    });

    test('idempotent: starting the same URL again is a no-op', async () => {
      const app = createStream();

      await app.stream.start(URL);
      await app.stream.start(URL);

      assert.equal(pipelineInstances.length, 1);
      assert.equal(app.pipeline.startCalls.length, 1);
    });

    test('should fetch youtube meta and post to icecast', async () => {
      const { promise: youtubeMetaPromise, resolve: resolveYoutubeMetaPromise } = Promise.withResolvers();
      youtubeMeta = youtubeMetaPromise;

      const app = createStream();
      const onStarted = mock.fn();
      app.events.on(Event.streamStarted, onStarted);

      const startPromise = app.stream.start(URL);

      await sleep(0);

      assert.deepEqual(getYoutubeMetaFake.mock.callCount(), 1, 'should retrieve Youtube data');
      assert.deepEqual(getYoutubeMetaFake.mock.calls[0].arguments[0], URL, 'should request w/ stream URL');

      resolveYoutubeMetaPromise({
        title: 'lofi hip-hop',
        author_name: 'LoFi Girl'
      });

      await sleep(0);

      assert.deepEqual(app.icecast.setMetadata.mock.callCount(), 1, 'should pass data to Icecast');
      assert.deepEqual(app.icecast.setMetadata.mock.calls[0].arguments[0], 'LoFi Girl - lofi hip-hop');

      await startPromise;
    });

    test('fail fast: unreachable Icecast rejects before any pipeline is created', async () => {
      const app = createStream();
      const onError = mock.fn();
      app.events.on(Event.streamError, onError);
      app.icecast.prepareMountPoint = async () => {
        throw new Error('Icecast unreachable — cannot start stream');
      };

      await assert.rejects(app.stream.start(URL), /Icecast unreachable/);

      assert.equal(pipelineInstances.length, 0);
      assert.equal(onError.mock.callCount(), 1);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('a pipeline start failure is torn down, reported, and rethrown', async () => {
      const app = createStream();
      const onError = mock.fn();
      app.events.on(Event.streamError, onError);
      StreamPipelineFake.next = { startError: new Error('streamlink exited before the mountpoint became active') };

      await assert.rejects(app.stream.start(URL), /streamlink exited/);

      assert.equal(app.pipeline.stopCalls, 1, 'the failed pipeline is torn down');
      assert.equal(onError.mock.callCount(), 1);
      assert.equal(onError.mock.calls[0].arguments[0].url, URL);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('a failed start logs the proxy the pipeline picked', async () => {
      const logger = captureLogger();
      const app = createStream(logger);
      StreamPipelineFake.next = {
        lastProxy: 'http://proxy:3128',
        startError: new Error('streamlink exited before the mountpoint became active')
      };

      await assert.rejects(app.stream.start(URL), /streamlink exited/);

      const failure = logger.entries.find((entry) => entry.msg === 'failed to start stream');
      assert.equal(failure.level, 'error');
      assert.equal(failure.proxy, 'http://proxy:3128');
    });

    test('replacing a stream: records the old one as replaced, then starts anew', async () => {
      const app = createStream();
      const order = [];
      app.events.on(Event.streamStarted, ({ url }) => order.push(`started:${url.slice(-3)}`));
      app.events.on(Event.streamStopped, ({ url, reason }) => order.push(`stopped:${url.slice(-3)}:${reason}`));
      const prepare = mock.fn(async () => {});
      app.icecast.prepareMountPoint = prepare;

      await app.stream.start('https://youtube.com/watch?v=abc');
      await app.stream.start('https://youtube.com/watch?v=def');

      assert.deepEqual(order, ['started:abc', 'stopped:abc:replaced', 'started:def']);
      assert.equal(prepare.mock.callCount(), 2);
      assert.equal(pipelineInstances.length, 2);
      assert.equal(pipelineInstances[0].stopCalls, 1, 'the replaced pipeline was stopped');
      assert.deepEqual(pipelineInstances[0].ttlWatcher.watched, ['https://youtube.com/watch?v=abc']);
      assert.equal(pipelineInstances[0].ttlWatcher.stops, 1); // the old stream's watcher was stopped
      const status = await app.stream.getStatus();
      assert.equal(status.general.state, 'streaming');
      assert.equal(status.general.url, 'https://youtube.com/watch?v=def');
    });

    test('failed replace: the old stream is recorded as replaced, the new one as an error', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      const onError = mock.fn();
      app.events.on(Event.streamStopped, onStopped);
      app.events.on(Event.streamError, onError);

      await app.stream.start('https://youtube.com/watch?v=abc');

      app.icecast.prepareMountPoint = async () => {
        throw new Error('old source still connected to the mountpoint');
      };
      await assert.rejects(app.stream.start('https://youtube.com/watch?v=def'), /old source still connected/);

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], {
        reason: 'replaced',
        url: 'https://youtube.com/watch?v=abc'
      });
      assert.equal(onError.mock.callCount(), 1);
      assert.equal(onError.mock.calls[0].arguments[0].url, 'https://youtube.com/watch?v=def');
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });
  });

  describe('streamUrl', () => {
    test('streamUrl proxies the Icecast mount URL', () => {
      const app = createStream();
      assert.equal(app.stream.streamUrl, MOUNT_URL);
    });
  });

  describe('stop', () => {
    test('stop() emits stream:stopped with reason manual and stops the TTL watcher', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL);
      await app.stream.stop();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'manual', url: URL });
      assert.equal(app.pipeline.stopCalls, 1);
      assert.equal(app.pipeline.ttlWatcher.stops, 1);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('stop() on idle is a no-op', async () => {
      const app = createStream();
      await app.stream.stop();
      assert.equal(pipelineInstances.length, 0);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });
  });

  describe('events', () => {
    test('unexpected process exit emits stream:stopped with reason process-exit', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL);
      app.pipeline.die();
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'process-exit', url: URL });
      assert.equal(app.pipeline.ttlWatcher.stops, 1);
    });

    test('TTL expiry stops the stream with reason ttl', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL);
      app.pipeline.expire();
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'ttl', url: URL });
    });

    test('a stale TTL teardown does not stop a replacement stream', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL); // stream A streaming

      // Park the stale teardown on A's stop.
      let releaseStop;
      const gate = new Promise((resolve) => {
        releaseStop = resolve;
      });
      const stopped = pipelineInstances[0].stop.bind(pipelineInstances[0]);
      let first = true;
      pipelineInstances[0].stop = async () => {
        if (first) {
          first = false;
          await gate; // the stale TTL teardown waits here
        }
        return stopped();
      };
      pipelineInstances[0].expire(); // -> #stopPipeline('ttl', A) gated on A.stop()

      await app.stream.start('https://youtube.com/watch?v=def'); // replace A with B
      releaseStop(); // let the stale teardown resume past its first stop
      await flushAsync();

      const status = await app.stream.getStatus();
      assert.equal(status.general.state, 'streaming');
      assert.equal(status.general.url, 'https://youtube.com/watch?v=def');
      // No spurious ttl stop for the replacement.
      assert.equal(onStopped.mock.calls.filter((call) => call.arguments[0].reason === 'ttl').length, 0);
      // The replacement pipeline was never stopped by the stale teardown.
      assert.equal(pipelineInstances.at(-1).stopCalls, 0);
    });

    test('a pipe cascade (both processes dying) emits exactly one stream:stopped', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL);
      app.pipeline.die({ cmd: 'streamlink', code: 1, signal: null, pid: 4242, errors: '' });
      app.pipeline.die({ cmd: 'ffmpeg', code: 1, signal: null, pid: 4243, errors: '' });
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'process-exit', url: URL });
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('a late process-exit after a manual stop does not emit stream:stopped twice', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL);
      await app.stream.stop();
      app.pipeline.die();
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
    });
  });

  describe('getStatus', () => {
    test('getStatus reports the full snapshot', async () => {
      const app = createStream();
      app.icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 3 };

      const status = await app.stream.getStatus();

      assert.deepEqual(status, {
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
      assert.equal(status.icecast.status, 'unavailable');
      assert.equal(status.icecast.state, 'stopped');
      assert.equal(status.icecast.listeners, 0);
    });

    test('getStatus while streaming includes running processes and the URL', async () => {
      const app = createStream();
      app.icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 2 };

      await app.stream.start(URL);

      const status = await app.stream.getStatus();
      assert.equal(status.streamlink.status, 'running');
      assert.equal(status.ffmpeg.status, 'running');
      assert.equal(status.icecast.state, 'streaming');
      assert.equal(status.icecast.listeners, 2);
      assert.equal(status.general.state, 'streaming');
      assert.equal(status.general.url, URL);
    });

    test('getStatus remembers the last URL after a stop', async () => {
      const app = createStream();
      await app.stream.start(URL);
      await app.stream.stop();

      const status = await app.stream.getStatus();
      assert.equal(status.general.state, 'idle');
      assert.equal(status.general.url, URL);
      assert.equal(app.pipeline.ttlWatcher.stops, 1);
    });
  });
});

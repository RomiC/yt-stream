import { describe, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, Event } from '../src/events.js';
import { silentLogger, flushAsync } from './helpers.js';

const URL = 'https://youtube.com/watch?v=abc';
const SOURCE_URL = 'icecast://source:testsource@icecast:8000/stream';
const MOUNT_URL = 'http://localhost:8000/stream';

let icecastInstances = [];
let streamlinkInstances = [];
let ffmpegInstances = [];
let ttlWatcherInstances = [];
let Stream;

before(async (ctx) => {
  icecastInstances = [];
  streamlinkInstances = [];
  ffmpegInstances = [];
  ttlWatcherInstances = [];

  ctx.mock.module('../src/icecast.js', {
    exports: {
      Icecast: class FakeIcecast {
        constructor() {
          this.status = { icecastReachable: true, mountpointActive: false, listeners: 0 };
          icecastInstances.push(this);
        }

        async prepareMountPoint() {}
        async waitForMountpoint() {}
        async pollNow() {
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

  ctx.mock.module('../src/streamlink.js', {
    exports: {
      Streamlink: class FakeStreamlink {
        constructor() {
          this.spawned = false;
          streamlinkInstances.push(this);
        }

        async spawnProcess() {
          this.spawned = true;
          return this;
        }

        pipe() {}

        async kill() {
          return true;
        }

        isAlive() {
          return this.spawned;
        }
      }
    }
  });

  ctx.mock.module('../src/ffmpeg.js', {
    exports: {
      Ffmpeg: class FakeFfmpeg {
        constructor() {
          this.spawned = false;
          ffmpegInstances.push(this);
        }

        async spawnProcess() {
          this.spawned = true;
        }

        async kill() {
          return true;
        }

        isAlive() {
          return this.spawned;
        }
      }
    }
  });

  ctx.mock.module('../src/ttlWatcher.js', {
    exports: {
      TTLWatcher: class FakeTTLWatcher {
        constructor() {
          this.watched = [];
          this.stops = 0;
          ttlWatcherInstances.push(this);
        }

        watch(url) {
          this.watched.push(url);
        }

        stop() {
          this.stops += 1;
        }
      }
    }
  });

  ({ Stream } = await import('../src/stream.js'));
});

/** Builds a Stream with fresh fakes; returns the latest instances. */
function createStream() {
  const events = new EventBus();
  const stream = new Stream({ config: { streamTtlMinutes: 15 }, logger: silentLogger(), events });
  return {
    stream,
    events,
    icecast: icecastInstances[icecastInstances.length - 1],
    streamlink: streamlinkInstances[streamlinkInstances.length - 1],
    ffmpeg: ffmpegInstances[ffmpegInstances.length - 1],
    ttlWatcher: ttlWatcherInstances[ttlWatcherInstances.length - 1]
  };
}

describe('Stream', () => {
  describe('start', () => {
    test('happy path: prepare, spawn, pipe, wait for mountpoint, watch TTL, emit stream:started', async () => {
      const { stream, events, streamlink, ffmpeg, ttlWatcher } = createStream();
      const onStarted = mock.fn();
      events.on(Event.streamStarted, onStarted);
      const pipe = mock.fn();
      streamlink.pipe = pipe;
      const spawnFfmpeg = mock.fn(async () => ffmpeg);
      ffmpeg.spawnProcess = spawnFfmpeg;

      await stream.start(URL);

      assert.equal(pipe.mock.callCount(), 1);
      assert.equal(pipe.mock.calls[0].arguments[0], ffmpeg);
      assert.equal(spawnFfmpeg.mock.callCount(), 1);
      assert.equal(spawnFfmpeg.mock.calls[0].arguments[0], SOURCE_URL);
      assert.deepEqual(ttlWatcher.watched, [URL]);
      assert.equal(onStarted.mock.callCount(), 1);
      assert.deepEqual(onStarted.mock.calls[0].arguments[0], { url: URL });
    });

    test('idempotent: starting the same URL again is a no-op', async () => {
      const { stream, streamlink, ttlWatcher } = createStream();
      streamlink.spawnProcess = mock.fn(async () => streamlink);

      await stream.start(URL);
      await stream.start(URL);

      assert.equal(streamlink.spawnProcess.mock.callCount(), 1);
      assert.deepEqual(ttlWatcher.watched, [URL]);
    });

    test('fail fast: unreachable Icecast rejects before spawning', async () => {
      const { stream, events, icecast, streamlink } = createStream();
      const onError = mock.fn();
      events.on(Event.streamError, onError);
      icecast.prepareMountPoint = async () => {
        throw new Error('Icecast unreachable — cannot start stream');
      };
      streamlink.spawnProcess = mock.fn();

      await assert.rejects(stream.start(URL), /Icecast unreachable/);

      assert.equal(streamlink.spawnProcess.mock.callCount(), 0);
      assert.equal(onError.mock.callCount(), 1);
      assert.equal((await stream.getStatus()).general.state, 'idle');
    });

    test('failure: waitForMountpoint rejection propagates, kills the pipeline and emits stream:error', async () => {
      const { stream, events, icecast, streamlink, ffmpeg } = createStream();
      const onError = mock.fn();
      events.on(Event.streamError, onError);
      icecast.waitForMountpoint = async () => {
        throw new Error('pipeline exited before connecting to Icecast');
      };
      const killStreamlink = mock.fn(async () => true);
      const killFfmpeg = mock.fn(async () => true);
      streamlink.kill = killStreamlink;
      ffmpeg.kill = killFfmpeg;

      await assert.rejects(stream.start(URL), /pipeline exited/);

      assert.equal(onError.mock.callCount(), 1);
      assert.ok(onError.mock.calls[0].arguments[0].error.includes('pipeline exited'));
      assert.equal(killStreamlink.mock.callCount(), 1);
      assert.equal(killFfmpeg.mock.callCount(), 1);
      assert.equal((await stream.getStatus()).general.state, 'idle');
    });

    test('replacing a stream: stop the old pipeline, then start anew', async () => {
      const { stream, icecast, streamlink, ttlWatcher } = createStream();
      const prepare = mock.fn(async () => {});
      icecast.prepareMountPoint = prepare;
      streamlink.spawnProcess = mock.fn(async () => streamlink);

      await stream.start('https://youtube.com/watch?v=abc');
      await stream.start('https://youtube.com/watch?v=def');

      assert.equal(prepare.mock.callCount(), 2);
      assert.deepEqual(ttlWatcher.watched, ['https://youtube.com/watch?v=abc', 'https://youtube.com/watch?v=def']);
      assert.equal(ttlWatcher.stops, 1); // the old stream's watcher was stopped
      const status = await stream.getStatus();
      assert.equal(status.general.state, 'streaming');
      assert.equal(status.general.url, 'https://youtube.com/watch?v=def');
    });
  });

  describe('streamUrl', () => {
    test('streamUrl proxies the Icecast mount URL', () => {
      const { stream } = createStream();
      assert.equal(stream.streamUrl, MOUNT_URL);
    });
  });

  describe('stop', () => {
    test('stop() emits stream:stopped with reason manual and stops the TTL watcher', async () => {
      const { stream, events, ttlWatcher } = createStream();
      const onStopped = mock.fn();
      events.on(Event.streamStopped, onStopped);

      await stream.start(URL);
      await stream.stop();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'manual', url: URL });
      assert.equal(ttlWatcher.stops, 1);
      assert.equal((await stream.getStatus()).general.state, 'stopped');
    });

    test('stop() on idle is a no-op', async () => {
      const { stream, ttlWatcher } = createStream();

      await stream.stop();

      assert.equal(ttlWatcher.stops, 0);
      assert.equal((await stream.getStatus()).general.state, 'idle');
    });
  });

  describe('events', () => {
    test('unexpected process exit emits stream:stopped with reason process-exit', async () => {
      const { stream, events, ttlWatcher } = createStream();
      const onStopped = mock.fn();
      events.on(Event.streamStopped, onStopped);

      await stream.start(URL);
      events.emit(Event.processExited, { cmd: 'ffmpeg', code: 1, pid: 99 });
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'process-exit', url: URL });
      assert.equal(ttlWatcher.stops, 1);
    });

    test('ttl:expired stops the stream with reason ttl', async () => {
      const { stream, events } = createStream();
      const onStopped = mock.fn();
      events.on(Event.streamStopped, onStopped);

      await stream.start(URL);
      events.emit(Event.ttlExpired, { url: URL });
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'ttl', url: URL });
    });

    test('a late process-exit after a manual stop does not emit stream:stopped twice', async () => {
      const { stream, events } = createStream();
      const onStopped = mock.fn();
      events.on(Event.streamStopped, onStopped);

      await stream.start(URL);
      await stream.stop();
      events.emit(Event.processExited, { cmd: 'streamlink', code: 1, pid: 99 });
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
    });
  });

  describe('getStatus', () => {
    test('getStatus reports the full snapshot', async () => {
      const { stream, icecast } = createStream();
      icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 3 };

      const status = await stream.getStatus();

      assert.deepEqual(status, {
        streamlink: { status: 'stopped' },
        ffmpeg: { status: 'stopped' },
        icecast: { status: 'available', state: 'streaming' },
        general: { state: 'idle', url: null }
      });
    });

    test('getStatus reports unavailable Icecast', async () => {
      const { stream, icecast } = createStream();
      icecast.status = { icecastReachable: false, mountpointActive: false, listeners: 0 };

      const status = await stream.getStatus();

      assert.equal(status.icecast.status, 'unavailable');
      assert.equal(status.icecast.state, 'stopped');
    });

    test('getStatus while streaming includes running processes and the URL', async () => {
      const { stream, icecast } = createStream();
      icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 2 };

      await stream.start(URL);

      const status = await stream.getStatus();
      assert.equal(status.streamlink.status, 'running');
      assert.equal(status.ffmpeg.status, 'running');
      assert.equal(status.icecast.state, 'streaming');
      assert.equal(status.general.state, 'streaming');
      assert.equal(status.general.url, URL);
    });

    test('getStatus remembers the last URL after a stop', async () => {
      const { stream, ttlWatcher } = createStream();

      await stream.start(URL);
      await stream.stop();

      const status = await stream.getStatus();
      assert.equal(status.general.state, 'stopped');
      assert.equal(status.general.url, URL);
      assert.equal(ttlWatcher.stops, 1);
    });
  });
});

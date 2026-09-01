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
let StreamlinkFake;
let FfmpegFake;
let Stream;

before(async (ctx) => {
  icecastInstances = [];
  streamlinkInstances = [];
  ffmpegInstances = [];
  ttlWatcherInstances = [];

  ctx.mock.module('../src/icecast.js', {
    exports: {
      IcecastUnreachableError: class IcecastUnreachableError extends Error {
        constructor() {
          super('Icecast unreachable — cannot start stream');
        }
      },
      Icecast: class FakeIcecast {
        constructor() {
          this.status = { icecastReachable: true, mountpointActive: true, listeners: 0 };
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

  class FakeStreamlink {
    static next = null;
    exitCallbacks = [];
    spawnCalls = [];
    pipeCalls = [];

    constructor() {
      this.spawned = false;
      // Overrides installed via StreamlinkFake.next apply to the current set only.
      Object.assign(this, FakeStreamlink.next ?? {});
      FakeStreamlink.next = null;
      streamlinkInstances.push(this);
    }

    onExit(callback) {
      this.exitCallbacks.push(callback);
    }

    die(code = 1, signal = null) {
      for (const callback of this.exitCallbacks) {
        callback({ code, signal, pid: 4242, errors: this.errorTail ?? '' });
      }
    }

    get command() {
      return 'streamlink';
    }

    get lastProxy() {
      return null;
    }

    async spawnProcess(url) {
      this.spawnCalls.push(url);
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
    exitCallbacks = [];
    spawnCalls = [];

    constructor() {
      this.spawned = false;
      Object.assign(this, FfmpegFake.next ?? {});
      FfmpegFake.next = null;
      ffmpegInstances.push(this);
    }

    onExit(callback) {
      this.exitCallbacks.push(callback);
    }

    die(code = 1, signal = null) {
      for (const callback of this.exitCallbacks) {
        callback({ code, signal, pid: 4242, errors: this.errorTail ?? '' });
      }
    }

    get command() {
      return 'ffmpeg';
    }

    async spawnProcess(sourceUrl) {
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
          this.watched = [];
          this.stops = 0;
          ttlWatcherInstances.push(this);
        }

        onExpired(callback) {
          this.expiredCallbacks.push(callback);
        }

        expire() {
          for (const callback of this.expiredCallbacks) {
            callback({ url: this.watched.at(-1) });
          }
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

/**
 * Builds a Stream with fresh fakes. The per-set instances (streamlink, ffmpeg,
 * ttlWatcher) are getters that resolve to the CURRENT set at access time — so
 * read them *after* the relevant start()/stop(). icecast is a single shared
 * instance.
 */
function createStream(timeouts = {}) {
  icecastInstances = [];
  streamlinkInstances = [];
  ffmpegInstances = [];
  ttlWatcherInstances = [];
  const events = new EventBus();
  const stream = new Stream({
    config: {
      streamTtlMinutes: 15,
      streamlinkQuality: 'audio_only,worst',
      proxyList: [],
      icecast: {
        host: 'icecast',
        port: 8000,
        sourcePassword: 'testsource',
        adminPassword: 'testadmin',
        publicPort: 8000
      },
      publicHostname: 'localhost'
    },
    logger: silentLogger(),
    events,
    timeouts
  });
  return {
    stream,
    events,
    get icecast() {
      return icecastInstances.at(-1);
    },
    get streamlink() {
      return streamlinkInstances.at(-1);
    },
    get ffmpeg() {
      return ffmpegInstances.at(-1);
    },
    get ttlWatcher() {
      return ttlWatcherInstances.at(-1);
    }
  };
}

describe('Stream', () => {
  describe('start', () => {
    test('happy path: prepare, spawn, pipe, wait for mountpoint, watch TTL, emit stream:started', async () => {
      const app = createStream();
      const onStarted = mock.fn();
      app.events.on(Event.streamStarted, onStarted);

      await app.stream.start(URL);

      assert.deepEqual(app.streamlink.spawnCalls, [URL]);
      assert.deepEqual(app.ffmpeg.spawnCalls, [SOURCE_URL]);
      assert.equal(app.streamlink.pipeCalls[0], app.ffmpeg);
      assert.deepEqual(app.ttlWatcher.watched, [URL]);
      assert.equal(onStarted.mock.callCount(), 1);
      assert.deepEqual(onStarted.mock.calls[0].arguments[0], { url: URL });
    });

    test('idempotent: starting the same URL again is a no-op', async () => {
      const app = createStream();

      await app.stream.start(URL);
      await app.stream.start(URL);

      assert.equal(app.streamlink.spawnCalls.length, 1);
      assert.deepEqual(app.ttlWatcher.watched, [URL]);
    });

    test('fail fast: unreachable Icecast rejects before spawning', async () => {
      const app = createStream();
      const onError = mock.fn();
      app.events.on(Event.streamError, onError);
      app.icecast.prepareMountPoint = async () => {
        throw new Error('Icecast unreachable — cannot start stream');
      };

      await assert.rejects(app.stream.start(URL), /Icecast unreachable/);

      assert.equal(streamlinkInstances.length, 0);
      assert.equal(onError.mock.callCount(), 1);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('failure: a dead pipeline process fails the start with attribution', async () => {
      const app = createStream();
      const onError = mock.fn();
      app.events.on(Event.streamError, onError);
      app.icecast.status = { icecastReachable: true, mountpointActive: false, listeners: 0 };
      StreamlinkFake.next = {
        spawnProcess: async function () {
          this.spawned = true;
          this.errorTail = 'error: No playable streams found for this URL\n';
          this.die();
          return this;
        }
      };

      await assert.rejects(
        app.stream.start(URL),
        /streamlink exited before the mountpoint became active \(code 1\).*No playable streams/
      );

      assert.equal(onError.mock.callCount(), 1);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('a mid-start process exit is attributed to the dead process, not the killed survivor', async () => {
      const app = createStream({ pollInterval: 1 });
      app.icecast.status = { icecastReachable: true, mountpointActive: false, listeners: 0 };
      FfmpegFake.next = {
        spawnProcess: async function () {
          this.spawned = true;
          this.die(null, 'SIGKILL'); // externally killed (OOM-style)
          return this;
        }
      };

      await assert.rejects(
        app.stream.start(URL),
        /ffmpeg exited before the mountpoint became active \(signal SIGKILL\)/
      );
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('readiness: keeps polling until the mountpoint becomes active', async () => {
      const app = createStream({ pollInterval: 1 });
      const onStarted = mock.fn();
      app.events.on(Event.streamStarted, onStarted);
      let calls = 0;
      app.icecast.getStatus = async () => {
        calls += 1;
        return { icecastReachable: true, mountpointActive: calls >= 3, listeners: 0 };
      };

      await app.stream.start(URL);

      assert.ok(calls >= 3);
      assert.equal(onStarted.mock.callCount(), 1);
    });

    test('readiness: fails when Icecast drops mid-wait', async () => {
      const app = createStream({ pollInterval: 1 });
      app.icecast.status = { icecastReachable: false, mountpointActive: false, listeners: 0 };

      await assert.rejects(app.stream.start(URL), /Icecast unreachable/);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('readiness: times out when the mountpoint never activates and nothing exits', async () => {
      const app = createStream({ mountpointTimeout: 20, pollInterval: 1 });
      app.icecast.status = { icecastReachable: true, mountpointActive: false, listeners: 0 };

      await assert.rejects(app.stream.start(URL), /mountpoint never became active/);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
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
      assert.deepEqual(ttlWatcherInstances[0].watched, ['https://youtube.com/watch?v=abc']);
      assert.equal(ttlWatcherInstances[0].stops, 1); // the old stream's watcher was stopped
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
      assert.equal(app.ttlWatcher.stops, 1);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });

    test('stop() on idle is a no-op', async () => {
      const app = createStream();
      await app.stream.stop();
      assert.equal(ttlWatcherInstances.length, 0);
      assert.equal((await app.stream.getStatus()).general.state, 'idle');
    });
  });

  describe('events', () => {
    test('unexpected process exit emits stream:stopped with reason process-exit', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL);
      app.ffmpeg.die();
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'process-exit', url: URL });
      assert.equal(app.ttlWatcher.stops, 1);
    });

    test('TTL expiry stops the stream with reason ttl', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL);
      app.ttlWatcher.expire();
      await flushAsync();

      assert.equal(onStopped.mock.callCount(), 1);
      assert.deepEqual(onStopped.mock.calls[0].arguments[0], { reason: 'ttl', url: URL });
    });

    test('a stale TTL teardown does not stop a replacement stream', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL); // stream A streaming

      // Park the stale teardown on A's first (streamlink) kill.
      let releaseKill;
      const gate = new Promise((resolve) => {
        releaseKill = resolve;
      });
      let first = true;
      app.streamlink.kill = async () => {
        if (first) {
          first = false;
          await gate; // the stale TTL teardown waits here
          return true;
        }
        return true; // the replace teardown passes through
      };
      app.ttlWatcher.expire(); // -> #stopPipeline('ttl', A) gated on streamlink.kill

      await app.stream.start('https://youtube.com/watch?v=def'); // replace A with B
      releaseKill(); // let the stale teardown resume past its first kill
      await flushAsync();

      const status = await app.stream.getStatus();
      assert.equal(status.general.state, 'streaming');
      assert.equal(status.general.url, 'https://youtube.com/watch?v=def');
      // No spurious ttl stop for the replacement.
      assert.equal(onStopped.mock.calls.filter((call) => call.arguments[0].reason === 'ttl').length, 0);
      // The replacement's ffmpeg survived the stale teardown.
      assert.equal(app.ffmpeg.spawned, true);
    });

    test('a late process-exit after a manual stop does not emit stream:stopped twice', async () => {
      const app = createStream();
      const onStopped = mock.fn();
      app.events.on(Event.streamStopped, onStopped);

      await app.stream.start(URL);
      await app.stream.stop();
      app.streamlink.die();
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
        icecast: { status: 'available', state: 'streaming' },
        general: { state: 'idle', url: null }
      });
    });

    test('getStatus reports unavailable Icecast', async () => {
      const app = createStream();
      app.icecast.status = { icecastReachable: false, mountpointActive: false, listeners: 0 };

      const status = await app.stream.getStatus();
      assert.equal(status.icecast.status, 'unavailable');
      assert.equal(status.icecast.state, 'stopped');
    });

    test('getStatus while streaming includes running processes and the URL', async () => {
      const app = createStream();
      app.icecast.status = { icecastReachable: true, mountpointActive: true, listeners: 2 };

      await app.stream.start(URL);

      const status = await app.stream.getStatus();
      assert.equal(status.streamlink.status, 'running');
      assert.equal(status.ffmpeg.status, 'running');
      assert.equal(status.icecast.state, 'streaming');
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
      assert.equal(app.ttlWatcher.stops, 1);
    });
  });
});

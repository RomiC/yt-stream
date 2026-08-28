import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TTLWatcher } from '../src/ttlWatcher.js';
import { EventBus, Event } from '../src/events.js';
import { silentLogger, flushAsync } from './helpers.js';

describe('TTLWatcher', () => {
  const URL = 'https://youtube.com/watch?v=abc';

  function makeWatcher(overrides = {}) {
    const events = new EventBus();
    const deps = {
      config: { streamTtlMinutes: 1 },
      logger: silentLogger(),
      events,
      icecast: {
        getStatus: async () => ({ icecastReachable: true, mountpointActive: true, listeners: 0 })
      },
      ...overrides
    };
    const watcher = new TTLWatcher(deps);
    return { watcher, events, getStatus: deps.icecast.getStatus };
  }

  test('emits ttl:expired when zero listeners persist past the TTL', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { watcher, events } = makeWatcher();
    const onTtlExpired = mock.fn();
    events.on(Event.ttlExpired, onTtlExpired);

    watcher.watch(URL);
    ctx.mock.timers.tick(60_000); // first tick: idle timer starts
    await flushAsync();
    ctx.mock.timers.tick(60_000); // 61s of zero listeners: TTL expired
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 1);
    assert.deepEqual(onTtlExpired.mock.calls[0].arguments[0], { url: URL });
  });

  test('listeners returning resets the idle timer', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    let listeners = 0;
    const { watcher, events } = makeWatcher({
      icecast: {
        getStatus: async () => ({ icecastReachable: true, mountpointActive: true, listeners })
      }
    });
    const onTtlExpired = mock.fn();
    events.on(Event.ttlExpired, onTtlExpired);

    watcher.watch(URL);
    ctx.mock.timers.tick(60_000); // idle starts
    await flushAsync();

    listeners = 1;
    ctx.mock.timers.tick(60_000); // listeners returned → idle reset
    await flushAsync();
    ctx.mock.timers.tick(60_000); // minutes pass, but listeners are present
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 0);
  });

  test('unreachable Icecast does not accumulate idle time', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { watcher, events } = makeWatcher({
      icecast: {
        getStatus: async () => ({ icecastReachable: false, mountpointActive: false, listeners: 0 })
      }
    });
    const onTtlExpired = mock.fn();
    events.on(Event.ttlExpired, onTtlExpired);

    watcher.watch(URL);
    ctx.mock.timers.tick(60_000);
    await flushAsync();
    ctx.mock.timers.tick(60_000);
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 0);
  });

  test('watch is a no-op when TTL is disabled', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval'] });
    const getStatus = mock.fn(async () => ({ icecastReachable: true, mountpointActive: true, listeners: 0 }));
    const { watcher } = makeWatcher({ config: { streamTtlMinutes: 0 }, icecast: { getStatus } });

    watcher.watch(URL);
    ctx.mock.timers.tick(600_000);

    assert.equal(getStatus.mock.callCount(), 0);
  });

  test('stop halts polling', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval'] });
    const getStatus = mock.fn(async () => ({ icecastReachable: true, mountpointActive: true, listeners: 0 }));
    const { watcher } = makeWatcher({ icecast: { getStatus } });

    watcher.watch(URL);
    ctx.mock.timers.tick(60_000);
    await flushAsync();
    watcher.stop();
    ctx.mock.timers.tick(600_000);

    assert.equal(getStatus.mock.callCount(), 1);
  });

  test('watch is idempotent and resets the idle state', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { watcher, events } = makeWatcher();
    const onTtlExpired = mock.fn();
    events.on(Event.ttlExpired, onTtlExpired);

    watcher.watch(URL);
    ctx.mock.timers.tick(60_000); // idle starts
    await flushAsync();
    watcher.watch(URL); // a new stream: idle time must not carry over
    ctx.mock.timers.tick(60_000); // but only one interval fires per period
    await flushAsync();
    ctx.mock.timers.tick(60_000);
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 1);
  });
});

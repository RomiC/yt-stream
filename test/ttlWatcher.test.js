import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TTLWatcher } from '../src/ttlWatcher.js';
import { silentLogger, flushAsync } from './helpers.js';

describe('TTLWatcher', () => {
  const URL = 'https://youtube.com/watch?v=abc';

  function makeWatcher(overrides = {}) {
    const deps = {
      config: { streamTtlMinutes: 1 },
      logger: silentLogger(),
      icecast: {
        getStatus: async () => ({ icecastReachable: true, mountpointActive: true, listeners: 0 })
      },
      ...overrides
    };
    const watcher = new TTLWatcher(deps);
    const onExpired = mock.fn();
    watcher.onExpired(onExpired);
    return { watcher, onExpired, getStatus: deps.icecast.getStatus };
  }

  test('notifies onExpired when zero listeners persist past the TTL', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { watcher, onExpired: onTtlExpired } = makeWatcher();

    watcher.watch(URL);
    await flushAsync(); // immediate tick: idle clock starts at t=0
    ctx.mock.timers.tick(60_000); // one poll interval = TTL elapsed → expiry
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 1);
  });

  test('expires exactly at the TTL, not one poll interval later', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { watcher, onExpired: onTtlExpired } = makeWatcher();

    watcher.watch(URL);
    await flushAsync(); // idle clock starts at watch() time, not at the first poll
    ctx.mock.timers.tick(60_000); // a single poll interval = the whole TTL
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 1);
    assert.deepEqual(onTtlExpired.mock.calls[0].arguments[0], { url: URL });
  });

  test('listeners returning resets the idle timer', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    let listeners = 0;
    const { watcher, onExpired: onTtlExpired } = makeWatcher({
      icecast: {
        getStatus: async () => ({ icecastReachable: true, mountpointActive: true, listeners })
      }
    });

    watcher.watch(URL);
    await flushAsync(); // immediate tick: idle starts
    listeners = 1;
    ctx.mock.timers.tick(60_000); // t=60: listeners present → idle reset
    await flushAsync();
    listeners = 0;
    ctx.mock.timers.tick(60_000); // t=120: idle restarts
    await flushAsync();
    ctx.mock.timers.tick(30_000); // t=150: 30s idle, no poll fires
    await flushAsync();
    listeners = 1;
    ctx.mock.timers.tick(30_000); // t=180: poll fires, listeners present → reset
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 0);
  });

  test('unreachable Icecast still accumulates idle time (TTL applies)', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { watcher, onExpired: onTtlExpired } = makeWatcher({
      icecast: {
        getStatus: async () => ({ icecastReachable: false, mountpointActive: false, listeners: 0 })
      }
    });

    watcher.watch(URL);
    await flushAsync(); // immediate tick: idle starts at t=0
    ctx.mock.timers.tick(60_000);
    await flushAsync();
    ctx.mock.timers.tick(60_000);
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 1);
  });

  test('re-watching resets idle time and does not stack intervals', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const getStatus = mock.fn(async () => ({ icecastReachable: true, mountpointActive: true, listeners: 0 }));
    const { watcher, onExpired: onTtlExpired } = makeWatcher({ icecast: { getStatus } });

    watcher.watch(URL);
    await flushAsync(); // immediate tick at t=0: idle starts
    ctx.mock.timers.tick(30_000); // t=30: 30s of idle, no poll fires

    watcher.watch(URL); // re-watch: idle reset, interval re-armed
    await flushAsync(); // immediate tick at t=30
    ctx.mock.timers.tick(30_000); // t=60: the OLD interval would fire here
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 0); // no carry-over, no stacked interval

    ctx.mock.timers.tick(30_000); // t=90: the new interval fires, idle elapsed = 60s
    await flushAsync();

    assert.equal(onTtlExpired.mock.callCount(), 1);
    assert.equal(getStatus.mock.callCount(), 3); // two immediate ticks + one poll
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
    await flushAsync(); // immediate tick
    ctx.mock.timers.tick(60_000);
    await flushAsync();
    watcher.stop();
    ctx.mock.timers.tick(600_000);

    assert.equal(getStatus.mock.callCount(), 2); // immediate + first interval
  });
});

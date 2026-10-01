import { afterEach, describe, expect, jest, test, vi } from 'bun:test';
import { TTLWatcher } from '../src/ttlWatcher';
import { flushAsync } from './helpers';
import type { IcecastProbe } from '../src/status';

const URL_UNDER_TEST = 'https://youtube.com/watch?v=abc';

function probe(listeners: number, reachable = true): IcecastProbe {
  return { icecastReachable: reachable, mountpointActive: reachable, listeners };
}

function makeWatcher(overrides: { streamTtlMinutes?: number; getStatus?: () => Promise<IcecastProbe> } = {}) {
  const getStatus = overrides.getStatus ?? (async () => probe(0));
  const watcher = new TTLWatcher({
    streamTtlMinutes: overrides.streamTtlMinutes ?? 1,
    icecast: { getStatus }
  });
  const onExpired = vi.fn();
  watcher.onExpired(onExpired);
  return { watcher, onExpired, getStatus };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('TTLWatcher', () => {
  test('notifies onExpired when zero listeners persist past the TTL', async () => {
    jest.useFakeTimers();
    const { watcher, onExpired } = makeWatcher();

    watcher.watch(URL_UNDER_TEST);
    await flushAsync();
    jest.advanceTimersByTime(60_000);
    await flushAsync();

    expect(onExpired.mock.calls.length).toBe(1);
  });

  test('expires exactly at the TTL, not one poll interval later', async () => {
    jest.useFakeTimers();
    const { watcher, onExpired } = makeWatcher();

    watcher.watch(URL_UNDER_TEST);
    await flushAsync();
    jest.advanceTimersByTime(60_000);
    await flushAsync();

    expect(onExpired.mock.calls.length).toBe(1);
    expect(onExpired.mock.calls[0][0]).toEqual({ url: URL_UNDER_TEST });
  });

  test('listeners returning resets the idle timer', async () => {
    jest.useFakeTimers();
    let listeners = 0;
    const { watcher, onExpired } = makeWatcher({ getStatus: async () => probe(listeners) });

    watcher.watch(URL_UNDER_TEST);
    await flushAsync();
    listeners = 1;
    jest.advanceTimersByTime(60_000);
    await flushAsync();
    listeners = 0;
    jest.advanceTimersByTime(60_000);
    await flushAsync();
    jest.advanceTimersByTime(30_000);
    await flushAsync();
    listeners = 1;
    jest.advanceTimersByTime(30_000);
    await flushAsync();

    expect(onExpired.mock.calls.length).toBe(0);
  });

  test('unreachable Icecast still accumulates idle time (TTL applies)', async () => {
    jest.useFakeTimers();
    const { watcher, onExpired } = makeWatcher({ getStatus: async () => probe(0, false) });

    watcher.watch(URL_UNDER_TEST);
    await flushAsync();
    jest.advanceTimersByTime(60_000);
    await flushAsync();
    jest.advanceTimersByTime(60_000);
    await flushAsync();

    expect(onExpired.mock.calls.length).toBe(1);
  });

  test('re-watching resets idle time and does not stack intervals', async () => {
    jest.useFakeTimers();
    const getStatus = vi.fn(async () => probe(0));
    const { watcher, onExpired } = makeWatcher({ getStatus });

    watcher.watch(URL_UNDER_TEST);
    await flushAsync();
    jest.advanceTimersByTime(30_000);

    watcher.watch(URL_UNDER_TEST);
    await flushAsync();
    jest.advanceTimersByTime(30_000);
    await flushAsync();

    expect(onExpired.mock.calls.length).toBe(0);

    jest.advanceTimersByTime(30_000);
    await flushAsync();

    expect(onExpired.mock.calls.length).toBe(1);
    expect(getStatus.mock.calls.length).toBe(3);
  });

  test('a stale poll from a previous watch does not disturb the new one', async () => {
    jest.useFakeTimers();
    let releaseOld: (value: IcecastProbe) => void = () => {};
    const oldPoll = new Promise<IcecastProbe>((resolve) => {
      releaseOld = resolve;
    });
    let calls = 0;
    const getStatus = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? oldPoll : probe(0);
    });
    const { watcher, onExpired } = makeWatcher({ getStatus });

    watcher.watch('https://youtube.com/watch?v=old');
    watcher.watch('https://youtube.com/watch?v=new');
    await flushAsync();
    releaseOld(probe(5));
    await flushAsync();

    jest.advanceTimersByTime(60_000);
    await flushAsync();

    expect(onExpired.mock.calls.length).toBe(1);
    expect((onExpired.mock.calls[0][0] as { url: string }).url).toBe('https://youtube.com/watch?v=new');
  });

  test('watch is a no-op when TTL is disabled', async () => {
    jest.useFakeTimers();
    const getStatus = vi.fn(async () => probe(0));
    const { watcher } = makeWatcher({ streamTtlMinutes: 0, getStatus });

    watcher.watch(URL_UNDER_TEST);
    jest.advanceTimersByTime(600_000);

    expect(getStatus.mock.calls.length).toBe(0);
  });

  test('stop halts polling', async () => {
    jest.useFakeTimers();
    const getStatus = vi.fn(async () => probe(0));
    const { watcher } = makeWatcher({ getStatus });

    watcher.watch(URL_UNDER_TEST);
    await flushAsync();
    jest.advanceTimersByTime(60_000);
    await flushAsync();
    watcher.stop();
    jest.advanceTimersByTime(600_000);

    expect(getStatus.mock.calls.length).toBe(2);
  });
});

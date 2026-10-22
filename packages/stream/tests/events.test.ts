import { describe, expect, test } from 'bun:test';
import { Event, EventBus } from '../src/events';

describe('EventBus', () => {
  test('emit delivers the payload to subscribed handlers', () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on(Event.streamStarted, (payload) => seen.push(payload));

    bus.emit(Event.streamStarted, { id: 'stream-1' });
    bus.emit(Event.streamStarted, { id: 'stream-2' });

    expect(seen).toEqual([{ id: 'stream-1' }, { id: 'stream-2' }]);
  });

  test('unrelated events do not reach handlers', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.on(Event.streamStarted, () => {
      calls += 1;
    });

    bus.emit(Event.streamStopped, { id: 'stream-1', reason: 'manual' });
    bus.emit(Event.streamError, { id: 'stream-1', error: 'boom' });

    expect(calls).toBe(0);
  });

  test('off unsubscribes a handler', () => {
    const bus = new EventBus();
    let calls = 0;
    const handler = (): void => {
      calls += 1;
    };

    bus.on(Event.streamStarted, handler);
    bus.emit(Event.streamStarted, { id: 'stream-1' });
    bus.off(Event.streamStarted, handler);
    bus.emit(Event.streamStarted, { id: 'stream-1' });

    expect(calls).toBe(1);
  });
});

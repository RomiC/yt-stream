import { describe, expect, test } from 'bun:test';
import { Event, EventBus } from '../src/events';

describe('EventBus', () => {
  test('emit delivers the payload to subscribed handlers', () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on(Event.streamStarted, (payload) => seen.push(payload));

    bus.emit(Event.streamStarted, { url: 'https://youtube.com/watch?v=abc' });
    bus.emit(Event.streamStarted, { url: 'https://youtu.be/xyz' });

    expect(seen).toEqual([{ url: 'https://youtube.com/watch?v=abc' }, { url: 'https://youtu.be/xyz' }]);
  });

  test('unrelated events do not reach handlers', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.on(Event.streamStarted, () => {
      calls += 1;
    });

    bus.emit(Event.streamStopped, { url: 'https://youtu.be/x', reason: 'manual' });
    bus.emit(Event.streamError, { url: 'https://youtu.be/x', error: 'boom' });

    expect(calls).toBe(0);
  });

  test('off unsubscribes a handler', () => {
    const bus = new EventBus();
    let calls = 0;
    const handler = (): void => {
      calls += 1;
    };

    bus.on(Event.streamStarted, handler);
    bus.emit(Event.streamStarted, { url: 'https://youtu.be/x' });
    bus.off(Event.streamStarted, handler);
    bus.emit(Event.streamStarted, { url: 'https://youtu.be/x' });

    expect(calls).toBe(1);
  });
});

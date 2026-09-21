import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, Event } from '../src/events.js';

describe('EventBus', () => {
  test('emit delivers the payload to subscribed handlers', () => {
    const bus = new EventBus();
    const handler = mock.fn();
    bus.on(Event.streamStarted, handler);

    bus.emit(Event.streamStarted, { url: 'https://youtube.com/watch?v=abc' });
    bus.emit(Event.streamStarted, { url: 'https://youtu.be/xyz' });

    assert.equal(handler.mock.callCount(), 2);
    assert.deepEqual(handler.mock.calls[0].arguments[0], { url: 'https://youtube.com/watch?v=abc' });
    assert.deepEqual(handler.mock.calls[1].arguments[0], { url: 'https://youtu.be/xyz' });
  });

  test('unrelated events do not reach handlers', () => {
    const bus = new EventBus();
    const handler = mock.fn();
    bus.on(Event.streamStarted, handler);

    bus.emit(Event.streamStopped, {});
    bus.emit(Event.streamError, {});

    assert.equal(handler.mock.callCount(), 0);
  });

  test('off unsubscribes a handler', () => {
    const bus = new EventBus();
    const handler = mock.fn();

    bus.on(Event.streamStarted, handler);
    bus.emit(Event.streamStarted, {});
    bus.off(Event.streamStarted, handler);
    bus.emit(Event.streamStarted, {});

    assert.equal(handler.mock.callCount(), 1);
  });
});

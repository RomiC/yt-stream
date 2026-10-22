import { EventEmitter } from 'node:events';

export const Event = {
  streamStarted: 'stream:started',
  streamStopped: 'stream:stopped',
  streamError: 'stream:error'
} as const;

export type StreamStopReason = 'manual' | 'replaced' | 'process-exit' | 'ttl' | 'start-failed';

export interface StreamIdentity {
  id: string;
  videoId: string;
}

export interface EventPayloads {
  [Event.streamStarted]: { id: string };
  [Event.streamStopped]: { id: string; reason: StreamStopReason };
  [Event.streamError]: { id: string; error: string };
}

export type StreamEvent = keyof EventPayloads;

type Handler<E extends StreamEvent> = (payload: EventPayloads[E]) => void;

export class EventBus {
  #emitter = new EventEmitter();

  on<E extends StreamEvent>(event: E, handler: Handler<E>): void {
    this.#emitter.on(event, handler);
  }

  off<E extends StreamEvent>(event: E, handler: Handler<E>): void {
    this.#emitter.off(event, handler);
  }

  emit<E extends StreamEvent>(event: E, payload: EventPayloads[E]): void {
    this.#emitter.emit(event, payload);
  }
}

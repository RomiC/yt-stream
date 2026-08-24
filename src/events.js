import { EventEmitter } from 'node:events';

/**
 * The domain events emitted on the bus (PRD §4.3). Subscribe and emit with
 * these constants project-wide — never raw string literals.
 *
 *   streamStarted     { url }
 *   streamStopped     { url, reason: 'manual'|'process-exit'|'mountpoint-lost'|'ttl' }
 *   streamError       { url, error }
 *   ttlExpired        { url }
 *   processExited     { cmd, code, pid }  (unexpected process exit)
 */
export const Event = Object.freeze({
  streamStarted: 'stream:started',
  streamStopped: 'stream:stopped',
  streamError: 'stream:error',
  ttlExpired: 'ttl:expired',
  processExited: 'process:exited'
});

/**
 * Pub/sub bus decoupling modules from each other.
 */
export class EventBus {
  #emitter = new EventEmitter();

  on(event, handler) {
    this.#emitter.on(event, handler);
  }

  off(event, handler) {
    this.#emitter.off(event, handler);
  }

  emit(event, payload) {
    this.#emitter.emit(event, payload);
  }
}

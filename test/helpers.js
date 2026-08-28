import { EventEmitter } from 'node:events';
import { Event } from '../src/events.js';

/**
 * Minimal fake of a child_process.ChildProcess for tests: an EventEmitter
 * with pid/kill/stdio plumbing, plus helpers to simulate close/error.
 * A healthy child "opens its stream": attaching a 'data' listener to stdout
 * immediately receives first bytes (satisfies streamlink's open-wait).
 */
export function createFakeChildProcess() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.exitCode = null;
  proc.killed = false;
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.pipe = () => proc.stdout;
  proc.stdout.on('newListener', (event) => {
    if (event === 'data') {
      queueMicrotask(() => proc.stdout.emit('data', Buffer.from('stream')));
    }
  });
  proc.stdin = { pipe() {}, end() {} };
  proc.kill = (signal) => {
    proc.killed = true;
    proc.signal = signal;
  };
  proc.emitClose = (code = 0) => {
    proc.exitCode = code;
    proc.emit('close', code);
  };
  proc.emitError = (message) => {
    proc.emit('error', new Error(message));
  };
  return proc;
}

export function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return silentLogger();
    }
  };
}

export function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Resolves after the microtask queue drains (used after event emissions). */
export function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Test double for the ChildProcess base class contract (spawn/kill/proc
 * tracking, stderr tail, process:exited emission with killed-proc
 * suppression). Used when testing Ffmpeg/Streamlink so the parent class can
 * be mocked instead of node:child_process. Records every spawn call into
 * `spawnCalls`.
 */
export function createFakeChildProcessBase({ spawnCalls }) {
  return class FakeChildProcess {
    _cmd;
    _logger;
    _events;
    _sigkillDelayMs;
    _proc = null;
    _errorTails = new WeakMap();
    _lastErrorTail = '';
    _killedProcs = new WeakSet();

    constructor({ cmd, logger, events, sigkillDelayMs = 5_000 }) {
      this._cmd = cmd;
      this._logger = logger;
      this._events = events;
      this._sigkillDelayMs = sigkillDelayMs;
    }

    async spawn(args, stdio) {
      if (this._proc) {
        await this.kill();
      }

      const proc = createFakeChildProcess();
      spawnCalls.push({ cmd: this._cmd, args, stdio });
      this._proc = proc;
      this._errorTails.set(proc, '');

      proc.stderr?.on('data', (data) => {
        const text = data.toString();
        this._errorTails.set(proc, (this._errorTails.get(proc) + text).slice(-2_000));
      });
      proc.on('error', (err) => this._logger.error({ err: err.message }, `${this._cmd} spawn error`));
      proc.on('close', (code) => {
        this._lastErrorTail = this._errorTails.get(proc) ?? '';
        if (this._proc === proc) {
          this._proc = null;
        }
        if (this._killedProcs.has(proc)) {
          this._killedProcs.delete(proc);
          return;
        }
        this._events?.emit(Event.processExited, { cmd: this._cmd, code, pid: proc.pid });
      });

      return proc;
    }

    kill() {
      const proc = this._proc;
      if (!proc) {
        return Promise.resolve(false);
      }
      this._proc = null;
      // Must precede the close event: the proc is about to die because of us,
      // so its close must not reach the bus.
      this._killedProcs.add(proc);

      return new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => {
          if (proc.exitCode === null) {
            proc.kill('SIGKILL');
          }
        }, this._sigkillDelayMs);
        proc.once('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
        proc.kill('SIGTERM');
      });
    }

    get process() {
      return this._proc;
    }

    isAlive() {
      return Boolean(this._proc);
    }

    getErrorTail() {
      return this._proc ? (this._errorTails.get(this._proc) ?? '') : this._lastErrorTail;
    }

    pipe(target) {
      this._proc.stdout.pipe(target._proc.stdin);
      return target;
    }
  };
}

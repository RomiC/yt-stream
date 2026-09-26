import { EventEmitter } from 'node:events';

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
  proc.emitClose = (code = 0, signal = null) => {
    proc.exitCode = code;
    proc.emit('close', code, signal);
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
 * Test double for the ChildProcess contract (one process per instance,
 * sync spawn, liveness). Used when testing Ffmpeg/Streamlink so the parent
 * class can be mocked instead of spawning the real binaries; the base itself
 * is tested for real in childProcessNew.test.js. Records every spawn call
 * into `spawnCalls`.
 */
export function createFakeChildProcessBase({ spawnCalls }) {
  return class FakeChildProcess {
    _cmd;
    _spawned = false;
    _proc = null;
    _exitCallbacks = [];

    constructor({ cmd, sigkillDelayMs = 5_000 }) {
      this._cmd = cmd;
      this._sigkillDelayMs = sigkillDelayMs;
    }

    onExit(callback) {
      this._exitCallbacks.push(callback);
    }

    spawn(args, stdio) {
      if (this._spawned) {
        throw new Error(`${this._cmd} instance already spawned — spawn a new instance instead`);
      }
      this._spawned = true;

      const proc = createFakeChildProcess();
      spawnCalls.push({ cmd: this._cmd, args, stdio });
      this._proc = proc;

      proc.on('close', (code, signal) => {
        this._proc = null;
        const exit = { cmd: this._cmd, code, signal, pid: proc.pid, errors: '' };
        for (const callback of this._exitCallbacks) {
          callback(exit);
        }
      });

      return proc;
    }

    kill() {
      const proc = this._proc;
      if (!proc) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => proc.kill('SIGKILL'), this._sigkillDelayMs);
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

    get pid() {
      return this._proc?.pid ?? null;
    }

    isAlive() {
      return Boolean(this._proc);
    }

    pipe(target) {
      this._proc.stdout.pipe(target._proc.stdin);
      return target;
    }
  };
}

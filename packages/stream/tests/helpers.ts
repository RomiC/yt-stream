import { EventEmitter } from 'node:events';

export { silentLogger } from 'yt-stream-shared';

export interface SpawnCall {
  cmd: string;
  args: string[];
  stdio: string[];
}

interface FakeProc extends EventEmitter {
  pid: number;
  exitCode: number | null;
  killed: boolean;
  signal?: string;
  stderr: EventEmitter;
  stdout: EventEmitter & { pipe: (target?: unknown) => unknown };
  stdin: { pipe: () => void; end: () => void };
  kill: (signal?: string) => void;
  emitClose: (code?: number, signal?: string | null) => void;
  emitError: (message: string) => void;
}

/** Minimal fake of a child_process.ChildProcess for tests: an EventEmitter with pid/kill/stdio plumbing. */
export function createFakeChildProcess(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = 4242;
  proc.exitCode = null;
  proc.killed = false;
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter() as FakeProc['stdout'];
  proc.stdout.pipe = () => proc.stdout;
  proc.stdout.on('newListener', (event) => {
    if (event === 'data') {
      queueMicrotask(() => proc.stdout.emit('data', Buffer.from('stream')));
    }
  });
  proc.stdin = { pipe: () => {}, end: () => {} };
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

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Resolves after the microtask queue drains (used after event emissions). */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeExit {
  cmd: string;
  code: number | null;
  signal: string | null;
  pid: number;
  errors: string;
}

/** Test double for the ChildProcess contract (one process per instance, sync spawn, liveness). */
export function createFakeChildProcessBase({ spawnCalls }: { spawnCalls: SpawnCall[] }) {
  return class FakeChildProcess {
    #cmd: string;
    #sigkillDelayMs: number;
    #spawned = false;
    #proc: FakeProc | null = null;
    #exitCallbacks: ((exit: FakeExit) => void)[] = [];

    constructor({ cmd, sigkillDelayMs = 5_000 }: { cmd: string; sigkillDelayMs?: number }) {
      this.#cmd = cmd;
      this.#sigkillDelayMs = sigkillDelayMs;
    }

    onExit(callback: (exit: FakeExit) => void): void {
      this.#exitCallbacks.push(callback);
    }

    spawn(args: string[], stdio: string[]): FakeProc {
      if (this.#spawned) {
        throw new Error(`${this.#cmd} instance already spawned — spawn a new instance instead`);
      }
      this.#spawned = true;

      const proc = createFakeChildProcess();
      spawnCalls.push({ cmd: this.#cmd, args, stdio });
      this.#proc = proc;

      proc.on('close', (code: number | null, signal: string | null) => {
        this.#proc = null;
        const exit: FakeExit = { cmd: this.#cmd, code, signal, pid: proc.pid, errors: '' };
        for (const callback of this.#exitCallbacks) {
          callback(exit);
        }
      });

      return proc;
    }

    kill(): Promise<boolean> {
      const proc = this.#proc;
      if (!proc) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => proc.kill('SIGKILL'), this.#sigkillDelayMs);
        proc.once('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
        proc.kill('SIGTERM');
      });
    }

    get process(): FakeProc | null {
      return this.#proc;
    }

    get pid(): number | null {
      return this.#proc?.pid ?? null;
    }

    isAlive(): boolean {
      return Boolean(this.#proc);
    }

    pipe(target: FakeChildProcess): FakeChildProcess {
      this.#proc!.stdout.pipe(target.#proc!.stdin);
      return target;
    }
  };
}

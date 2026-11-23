import { spawn } from 'node:child_process';
import type { ChildProcess as NodeChildProcess, StdioOptions } from 'node:child_process';

const SIGKILL_AFTER_MS = 5_000;
const EXIT_SETTLE_DELAY_MS = 250;
const KILL_GIVE_UP_MS = 1_000;

export interface ProcessExit {
  cmd: string;
  code: number | null;
  signal: string | null;
  pid: number | null;
  errors: string;
}

export interface ChildProcessOptions {
  cmd: string;
  sigkillDelayMs?: number;
}

/**
 * One-shot process wrapper: one instance mirrors exactly one child process — constructed, spawned once, running, exited (terminal).
 * Owner kills stay silent; every other exit reaches onExit subscribers with the full stderr tail.
 */
export class ChildProcess {
  #cmd: string;
  #sigkillDelayMs: number;
  #proc: NodeChildProcess | null = null;
  #pid: number | null = null;
  #spawned = false;
  #exited = false;
  #isKilledByOwner = false;
  #errors = '';
  #exitCallbacks: ((exit: ProcessExit) => void)[] = [];

  constructor({ cmd, sigkillDelayMs = SIGKILL_AFTER_MS }: ChildProcessOptions) {
    this.#cmd = cmd;
    this.#sigkillDelayMs = sigkillDelayMs;
  }

  get process(): NodeChildProcess | null {
    return this.#proc;
  }

  get pid(): number | null {
    return this.#pid;
  }

  isAlive(): boolean {
    return this.#spawned && !this.#exited;
  }

  spawn(args: string[], stdio: StdioOptions): this {
    if (this.#spawned) {
      throw new Error(`${this.#cmd} instance already spawned — spawn a new instance instead`);
    }
    this.#spawned = true;

    const proc = spawn(this.#cmd, args, { stdio });
    this.#proc = proc;
    this.#pid = proc.pid ?? null;

    proc.stderr?.on('data', (data: Buffer) => {
      this.#errors += data.toString();
    });
    proc.on('error', (err) => {
      this.#errors += err.message;
    });
    // Bun drops `close` once a stdio pipe broke, so `exit` settles the state after a grace period.
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    proc.on('exit', (code, signal) => {
      settleTimer = setTimeout(() => this.#settle(code, signal), EXIT_SETTLE_DELAY_MS);
    });
    proc.on('close', (code, signal) => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
      }
      this.#settle(code, signal);
    });

    return this;
  }

  #settle(code: number | null, signal: string | null): void {
    if (this.#exited) {
      return;
    }
    this.#markExited();
    if (this.#isKilledByOwner) {
      return;
    }
    const exit: ProcessExit = { cmd: this.#cmd, code, signal, pid: this.#pid, errors: this.#errors };
    for (const callback of this.#exitCallbacks) {
      callback(exit);
    }
  }

  #markExited(): void {
    this.#exited = true;
    this.#proc = null;
  }

  async kill(): Promise<boolean> {
    const proc = this.#proc;

    if (!proc) {
      return Promise.resolve(false);
    }

    this.#isKilledByOwner = true;

    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(sigkillTimer);
        clearTimeout(giveUpTimer);
        this.#markExited();
        resolve(true);
      };

      proc.once('close', done);
      proc.once('exit', done);
      const sigkillTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGKILL');
        }
      }, this.#sigkillDelayMs);
      const giveUpTimer = setTimeout(done, this.#sigkillDelayMs + KILL_GIVE_UP_MS);

      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
      }
    });
  }

  onExit(callback: (exit: ProcessExit) => void): this {
    this.#exitCallbacks.push(callback);
    return this;
  }

  pipe(target: ChildProcess): ChildProcess {
    const output = this.#proc!.stdout!;
    const input = target.#proc!.stdin!;
    // Killing one side breaks the pipe with EPIPE; an unhandled stream error takes the app down.
    output.on('error', () => {});
    input.on('error', () => {});
    output.pipe(input);
    return target;
  }
}

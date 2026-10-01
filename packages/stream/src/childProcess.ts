import { spawn } from 'node:child_process';
import type { ChildProcess as NodeChildProcess, StdioOptions } from 'node:child_process';

const SIGKILL_AFTER_MS = 5_000;

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
    proc.on('close', (code, signal) => {
      this.#exited = true;
      this.#proc = null;
      if (this.#isKilledByOwner) {
        return;
      }
      const exit: ProcessExit = { cmd: this.#cmd, code, signal, pid: this.#pid, errors: this.#errors };
      for (const callback of this.#exitCallbacks) {
        callback(exit);
      }
    });

    return this;
  }

  async kill(): Promise<boolean> {
    const proc = this.#proc;

    if (!proc) {
      return Promise.resolve(false);
    }

    this.#isKilledByOwner = true;

    return new Promise((resolve) => {
      proc.once('close', () => resolve(true));
      if (proc.exitCode === null) {
        const timer = setTimeout(() => {
          if (proc.exitCode === null) {
            proc.kill('SIGKILL');
          }
        }, this.#sigkillDelayMs);
        proc.once('close', () => clearTimeout(timer));
        proc.kill('SIGTERM');
      }
    });
  }

  onExit(callback: (exit: ProcessExit) => void): this {
    this.#exitCallbacks.push(callback);
    return this;
  }

  pipe(target: ChildProcess): ChildProcess {
    this.#proc!.stdout!.pipe(target.#proc!.stdin!);
    return target;
  }
}

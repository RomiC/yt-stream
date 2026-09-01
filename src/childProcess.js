import { spawn } from 'node:child_process';

const SIGKILL_AFTER_MS = 5_000;

/**
 * Base class for wrappers that own a single child process (streamlink,
 * ffmpeg). Provides spawn tracking, SIGTERM→SIGKILL kill that resolves once
 * the process has exited, and full stderr capture. It does not log — facts
 * flow out through the exit payload; the owner logs.
 *
 * Subclasses call spawn() with their args/stdio; unexpected exits are
 * reported to onExit subscribers so the owner can react.
 */
export class ChildProcess {
  #cmd;
  #sigkillDelayMs;
  #proc = null;
  #errors = new WeakMap();
  // Processes we killed ourselves; their close is not news (an
  // intentional stop is not an unexpected exit).
  #killedProcs = new WeakSet();
  #exitCallbacks = [];

  constructor({ cmd, sigkillDelayMs = SIGKILL_AFTER_MS }) {
    this.#cmd = cmd;
    this.#sigkillDelayMs = sigkillDelayMs;
  }

  /**
   * Spawns the command, replacing any previous process, and attaches
   * stderr/error/close handling. Resolves once the previous process (if any)
   * has fully exited.
   */
  async spawn(args, stdio) {
    if (this.#proc) {
      await this.kill();
    }

    const proc = spawn(this.#cmd, args, { stdio });
    this.#proc = proc;
    this.#errors.set(proc, '');

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      this.#errors.set(proc, this.#errors.get(proc) + text);
    });
    proc.on('error', (err) => {
      this.#errors.set(proc, (this.#errors.get(proc) ?? '') + err.message);
    });
    proc.on('close', (code, signal) => {
      if (this.#proc === proc) {
        this.#proc = null;
      }
      if (this.#killedProcs.has(proc)) {
        this.#killedProcs.delete(proc);
        return;
      }
      const exit = { code, signal, pid: proc.pid, errors: this.#errors.get(proc) ?? '' };
      for (const callback of this.#exitCallbacks) {
        callback(exit);
      }
    });

    return proc;
  }

  /**
   * SIGTERM, then SIGKILL if it hasn't exited within the grace period.
   * Resolves once the process has fully exited, or false when idle.
   */
  kill() {
    const proc = this.#proc;
    if (!proc) {
      return Promise.resolve(false);
    }
    this.#proc = null;
    // Must precede the close event: the proc is about to die because of us,
    // so its close must not be reported as an unexpected exit.
    this.#killedProcs.add(proc);

    return new Promise((resolve) => {
      if (proc.exitCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill('SIGKILL');
        }
      }, this.#sigkillDelayMs);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
      proc.kill('SIGTERM');
    });
  }

  get process() {
    return this.#proc;
  }

  get command() {
    return this.#cmd;
  }

  /** Subscribes to unexpected exits (deliberate kills stay silent). */
  onExit(callback) {
    this.#exitCallbacks.push(callback);
  }

  isAlive() {
    return Boolean(this.#proc);
  }

  /**
   * Pipes this process's stdout into another ChildProcess's stdin
   * (e.g. streamlink → ffmpeg).
   */
  pipe(target) {
    this.#proc.stdout.pipe(target.#proc.stdin);
    return target;
  }
}

import { spawn } from 'node:child_process';

const SIGKILL_AFTER_MS = 5_000;

/**
 * @typedef {object} ProcessExit
 * @property {string} cmd - the command that was run
 * @property {number|null} code - exit code; null when terminated by a signal
 * @property {string|null} signal - termination signal; null for a plain exit
 * @property {number} pid - the process id, preserved past exit
 * @property {string} errors - accumulated stderr and spawn/kill error messages
 */

/**
 * One-shot process wrapper: the instance mirrors exactly one child process — constructed, spawned once, running, exited (terminal).
 * No replacement: a new process is a new instance.
 * Owner kills stay silent; every other exit reaches onExit subscribers with the full stderr tail.
 */
export class ChildProcess {
  #cmd;
  #sigkillDelayMs;
  #proc = null;
  #pid = null;
  #spawned = false;
  #exited = false;
  #isKilledByOwner = false;
  #errors = '';
  #exitCallbacks = [];

  /**
   * @param {{cmd: string, sigkillDelayMs?: number}} options - command to run and the SIGKILL grace period for kill()
   */
  constructor({ cmd, sigkillDelayMs = SIGKILL_AFTER_MS }) {
    this.#cmd = cmd;
    this.#sigkillDelayMs = sigkillDelayMs;
  }

  /** @returns {import('node:child_process').ChildProcess|null} the live process; null before spawn and after exit */
  get process() {
    return this.#proc;
  }

  /** @returns {number|null} preserved past exit, so post-mortem facts can name it */
  get pid() {
    return this.#pid;
  }

  /** @returns {boolean} true between a successful spawn and the process close */
  isAlive() {
    return this.#spawned && !this.#exited;
  }

  /**
   * Spawns the single process this instance represents.
   * @param {string[]} args - command arguments
   * @param {string[]} stdio - child stdio configuration (e.g. ['ignore', 'pipe', 'pipe'])
   * @returns {ChildProcess} this instance, for chaining
   * @throws {Error} on a second spawn — a new process is a new instance
   */
  spawn(args, stdio) {
    if (this.#spawned) {
      throw new Error(`${this.#cmd} instance already spawned — spawn a new instance instead`);
    }
    this.#spawned = true;

    const proc = spawn(this.#cmd, args, { stdio });
    this.#proc = proc;
    this.#pid = proc.pid;

    proc.stderr?.on('data', (data) => {
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
      const exit = { cmd: this.#cmd, code, signal, pid: this.#pid, errors: this.#errors };
      for (const callback of this.#exitCallbacks) {
        callback(exit);
      }
    });

    return this;
  }

  /**
   * SIGTERM, then SIGKILL after the grace period.
   * Resolves on close (never on the earlier exit), so a resolved kill implies drained stdio.
   * @returns {Promise<boolean>} true once the process has closed; false when it was never running
   */
  async kill() {
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

  /**
   * Subscribes to the exit of a process the owner did not kill (owner kills stay silent).
   * @param {(exit: ProcessExit) => void} callback
   * @returns {ChildProcess} this instance, for chaining
   */
  onExit(callback) {
    this.#exitCallbacks.push(callback);
    return this;
  }

  /**
   * Pipes this process's stdout into another running instance's stdin.
   * @param {ChildProcess} target - the consumer of this process's output
   * @returns {ChildProcess} the target, for chaining
   */
  pipe(target) {
    this.#proc.stdout.pipe(target.#proc.stdin);
    return target;
  }
}

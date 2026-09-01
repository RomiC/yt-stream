import { spawn } from 'node:child_process';

const SIGKILL_AFTER_MS = 5_000;
const ERR_TAIL_LIMIT = 2_000;

/**
 * Base class for wrappers that own a single child process (streamlink,
 * ffmpeg). Provides spawn tracking, SIGTERM→SIGKILL kill that resolves once
 * the process has exited, stderr tail capture, and close/error logging.
 *
 * Subclasses call spawn() with their args/stdio; unexpected exits are
 * reported to onExit subscribers so the owner can react.
 */
export class ChildProcess {
  #cmd;
  #logger;
  #sigkillDelayMs;
  #proc = null;
  #errorTails = new WeakMap();
  #lastErrorTail = '';
  // Processes we killed ourselves; their close is not news (an
  // intentional stop is not an unexpected exit).
  #killedProcs = new WeakSet();
  #exitCallbacks = [];

  constructor({ cmd, logger, sigkillDelayMs = SIGKILL_AFTER_MS }) {
    this.#cmd = cmd;
    this.#logger = logger;
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
    this.#errorTails.set(proc, '');

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      this.#errorTails.set(proc, (this.#errorTails.get(proc) + text).slice(-ERR_TAIL_LIMIT));
      this.#logger.debug({ [this.#cmd]: text.trim() });
    });
    proc.on('error', (err) => this.#logger.error({ err: err.message }, `${this.#cmd} spawn error`));
    proc.on('close', (code, signal) => {
      this.#logger.warn({ code, signal, pid: proc.pid }, `${this.#cmd} exited`);
      this.#lastErrorTail = this.#errorTails.get(proc) ?? '';
      if (this.#proc === proc) {
        this.#proc = null;
      }
      if (this.#killedProcs.has(proc)) {
        this.#killedProcs.delete(proc);
        return;
      }
      const exit = { code, signal, pid: proc.pid };
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
    // so its close must not reach the event bus.
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

  /** Stderr tail of the current process; after its exit, of the last one. */
  getErrorTail() {
    return this.#proc ? (this.#errorTails.get(this.#proc) ?? '') : this.#lastErrorTail;
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

import { spawn } from 'node:child_process';
import { Event } from './events.js';

const SIGKILL_AFTER_MS = 5_000;
const ERR_TAIL_LIMIT = 2_000;

/**
 * Base class for wrappers that own a single child process (streamlink,
 * ffmpeg). Provides spawn tracking, SIGTERM→SIGKILL kill that resolves once
 * the process has exited, stderr tail capture, and close/error logging.
 *
 * Subclasses call spawn() with their args/stdio; unexpected exits emit
 * `process:exited` on the event bus so a coordinator can react.
 */
export class ChildProcess {
  #cmd;
  #logger;
  #events;
  #sigkillDelayMs;
  #proc = null;
  #errorTails = new WeakMap();
  // Processes we killed ourselves; their close must not reach the bus (an
  // intentional stop is not an unexpected exit).
  #killedProcs = new WeakSet();

  constructor({ cmd, logger, events, sigkillDelayMs = SIGKILL_AFTER_MS }) {
    this.#cmd = cmd;
    this.#logger = logger;
    this.#events = events;
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
    proc.on('close', (code) => {
      this.#logger.warn({ code, pid: proc.pid }, `${this.#cmd} exited`);
      if (this.#proc === proc) {
        this.#proc = null;
      }
      if (this.#killedProcs.has(proc)) {
        this.#killedProcs.delete(proc);
        return;
      }
      this.#events?.emit(Event.processExited, { cmd: this.#cmd, code, pid: proc.pid });
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

  getProcess() {
    return this.#proc;
  }

  /** Logger for subclasses (private fields are not inherited). */
  getLogger() {
    return this.#logger;
  }

  isAlive() {
    return Boolean(this.#proc);
  }

  /** Tail of the current process's stderr (for failure diagnostics). */
  getErrorTail() {
    return this.#proc ? (this.#errorTails.get(this.#proc) ?? '') : '';
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

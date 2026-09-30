import { hostname } from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// pino's numeric levels — keeps existing log parsing working
const LEVEL_VALUES: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const BASE_FIELDS = { pid: process.pid, hostname: hostname() };

export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  fatal(fields: Record<string, unknown>, message: string): void;
}

export function silentLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
}

export function createLogger(level: string): Logger {
  const threshold = LEVEL_VALUES[level as LogLevel] ?? LEVEL_VALUES.info;

  function write(levelName: LogLevel, fields: Record<string, unknown>, message: string): void {
    if (LEVEL_VALUES[levelName] < threshold) {
      return;
    }

    const line = JSON.stringify({
      level: LEVEL_VALUES[levelName],
      time: Date.now(),
      ...BASE_FIELDS,
      ...fields,
      msg: message
    });
    if (levelName === 'error' || levelName === 'fatal') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (fields, message) => write('debug', fields, message),
    info: (fields, message) => write('info', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    error: (fields, message) => write('error', fields, message),
    fatal: (fields, message) => write('fatal', fields, message)
  };
}

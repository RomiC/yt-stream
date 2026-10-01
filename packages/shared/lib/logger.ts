import { hostname } from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// pino's numeric levels — keeps existing log parsing working
const LEVEL_VALUES: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const BASE_FIELDS = { pid: process.pid, hostname: hostname() };

export interface Logger {
  debug(fieldsOrMessage: Record<string, unknown> | string, message?: string): void;
  info(fieldsOrMessage: Record<string, unknown> | string, message?: string): void;
  warn(fieldsOrMessage: Record<string, unknown> | string, message?: string): void;
  error(fieldsOrMessage: Record<string, unknown> | string, message?: string): void;
  fatal(fieldsOrMessage: Record<string, unknown> | string, message?: string): void;
}

export function silentLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
}

export function createLogger(level: string): Logger {
  const threshold = LEVEL_VALUES[level as LogLevel] ?? LEVEL_VALUES.info;

  function write(levelName: LogLevel, fieldsOrMessage: Record<string, unknown> | string, message?: string): void {
    if (LEVEL_VALUES[levelName] < threshold) {
      return;
    }

    const fields = typeof fieldsOrMessage === 'string' ? {} : fieldsOrMessage;
    const msg = typeof fieldsOrMessage === 'string' ? fieldsOrMessage : (message ?? '');
    const line = JSON.stringify({ level: LEVEL_VALUES[levelName], time: Date.now(), ...BASE_FIELDS, ...fields, msg });

    if (levelName === 'error' || levelName === 'fatal') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (fieldsOrMessage, message) => write('debug', fieldsOrMessage, message),
    info: (fieldsOrMessage, message) => write('info', fieldsOrMessage, message),
    warn: (fieldsOrMessage, message) => write('warn', fieldsOrMessage, message),
    error: (fieldsOrMessage, message) => write('error', fieldsOrMessage, message),
    fatal: (fieldsOrMessage, message) => write('fatal', fieldsOrMessage, message)
  };
}

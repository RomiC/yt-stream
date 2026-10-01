import type { ProcessExit } from '../childProcess';

export interface ExitDescription {
  how: string;
  tail: string;
}

export function describeExit(exit: ProcessExit): ExitDescription {
  const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
  const tail = exit.errors.split('\n').slice(-3).join(' | ');
  return { how, tail };
}

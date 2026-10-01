import { describe, expect, test } from 'bun:test';
import { describeExit } from '../../src/utils/describeExit';
import type { ProcessExit } from '../../src/childProcess';

function exit(overrides: Partial<ProcessExit> = {}): ProcessExit {
  return { cmd: 'ffmpeg', code: null, signal: null, pid: 1, errors: '', ...overrides };
}

describe('describeExit', () => {
  test('describes a signal termination', () => {
    const { how, tail } = describeExit(exit({ signal: 'SIGKILL' }));

    expect(how).toBe('signal SIGKILL');
    expect(tail).toBe('');
  });

  test('describes a plain exit code', () => {
    expect(describeExit(exit({ code: 1 })).how).toBe('code 1');
  });

  test('keeps only the last three stderr lines', () => {
    expect(describeExit(exit({ code: 1, errors: 'one\ntwo\nthree\nfour' })).tail).toBe('two | three | four');
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { describeExit } from '../../src/utils/describeExit.js';

describe('describeExit', () => {
  test('describes a signal termination', () => {
    const { how, tail } = describeExit({ signal: 'SIGKILL', code: null, errors: '' });

    assert.equal(how, 'signal SIGKILL');
    assert.equal(tail, '');
  });

  test('describes a plain exit code', () => {
    const { how } = describeExit({ signal: null, code: 1, errors: '' });

    assert.equal(how, 'code 1');
  });

  test('keeps only the last three stderr lines', () => {
    const { tail } = describeExit({ signal: null, code: 1, errors: 'one\ntwo\nthree\nfour' });

    assert.equal(tail, 'two | three | four');
  });
});

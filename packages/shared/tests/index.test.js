import test, { describe } from 'node:test';
import assert from 'node:assert';
import * as shared from '../index.js';

describe('shared', () => {
  test('exports Config', () => {
    assert.equal(typeof shared.Config, 'function');
  });
});

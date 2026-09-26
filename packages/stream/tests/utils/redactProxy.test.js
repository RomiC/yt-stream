import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { redactProxy } from '../../src/utils/redactProxy.js';

describe('redactProxy', () => {
  test('strips inline credentials', () => {
    assert.equal(redactProxy('http://user:pass@proxy:3128'), 'http://proxy:3128');
    assert.equal(redactProxy('http://:pass@proxy:3128'), 'http://proxy:3128');
  });

  test('leaves credential-free URLs untouched', () => {
    assert.equal(redactProxy('http://proxy:3128'), 'http://proxy:3128');
  });

  test('keeps non-default ports and drops paths; scheme defaults normalize away', () => {
    assert.equal(redactProxy('http://proxy:80'), 'http://proxy');
    assert.equal(redactProxy('http://user@proxy:3128/some/path'), 'http://proxy:3128');
    assert.equal(redactProxy('socks5h://user:pass@proxy:1080'), 'socks5h://proxy:1080');
  });
});

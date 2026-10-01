import { describe, expect, test } from 'bun:test';
import { redactProxy } from '../../src/utils/redactProxy';

describe('redactProxy', () => {
  test('strips inline credentials', () => {
    expect(redactProxy('http://user:pass@proxy:3128')).toBe('http://proxy:3128');
    expect(redactProxy('http://:pass@proxy:3128')).toBe('http://proxy:3128');
  });

  test('leaves credential-free URLs untouched', () => {
    expect(redactProxy('http://proxy:3128')).toBe('http://proxy:3128');
  });

  test('keeps non-default ports and drops paths; scheme defaults normalize away', () => {
    expect(redactProxy('http://proxy:80')).toBe('http://proxy');
    expect(redactProxy('http://user@proxy:3128/some/path')).toBe('http://proxy:3128');
    expect(redactProxy('socks5h://user:pass@proxy:1080')).toBe('socks5h://proxy:1080');
  });
});

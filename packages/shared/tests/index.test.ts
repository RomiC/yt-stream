import { describe, expect, test } from 'bun:test';
import * as shared from '../index';

describe('shared', () => {
  test('exports Config', () => {
    expect(typeof shared.Config).toBe('function');
  });
});

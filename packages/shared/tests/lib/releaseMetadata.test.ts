import { describe, expect, test } from 'bun:test';
import { getReleaseMetadata } from '../../lib/releaseMetadata';

describe('getReleaseMetadata', () => {
  test('returns dev defaults when env is empty', () => {
    expect(getReleaseMetadata({})).toEqual({ version: 'dev', commit: 'unknown' });
  });

  test('reads release metadata from env', () => {
    expect(getReleaseMetadata({ APP_VERSION: 'v1.0.0', APP_COMMIT: 'abc1234' })).toEqual({
      version: 'v1.0.0',
      commit: 'abc1234'
    });
  });
});

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createFakeChildProcessBase } from './helpers';
import type { SpawnCall } from './helpers';

const spawnCalls: SpawnCall[] = [];

let Streamlink: typeof import('../src/streamlink').Streamlink;

function makeConfig(overrides: { streamlinkQuality?: string } = {}) {
  return { streamlinkQuality: 'audio_only,worst', ...overrides };
}

beforeAll(async () => {
  mock.module('../src/childProcess', () => ({ ChildProcess: createFakeChildProcessBase({ spawnCalls }) }));
  ({ Streamlink } = await import('../src/streamlink'));
});

describe('Streamlink', () => {
  test('constructs without arguments', () => {
    expect(() => new Streamlink()).not.toThrow();
  });

  test('spawns streamlink with default-stream and output args (no proxy)', () => {
    spawnCalls.length = 0;
    const streamlink = new Streamlink(makeConfig());

    streamlink.spawnProcess('https://youtube.com/watch?v=abc');

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].cmd).toBe('streamlink');
    expect(spawnCalls[0].args).toEqual([
      '--default-stream',
      'audio_only,worst',
      '--output',
      '-',
      'https://youtube.com/watch?v=abc'
    ]);
    expect(spawnCalls[0].stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  test('spawns through the caller-chosen proxy', () => {
    spawnCalls.length = 0;
    const streamlink = new Streamlink(makeConfig());

    streamlink.spawnProcess('https://youtube.com/watch?v=abc', 'http://user:pass@proxy:3128');

    const args = spawnCalls[0].args;
    const proxyIndex = args.indexOf('--http-proxy');
    expect(proxyIndex).not.toBe(-1);
    expect(args[proxyIndex + 1]).toBe('http://user:pass@proxy:3128');
  });
});

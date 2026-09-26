import { describe, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChildProcessBase } from './helpers.js';

let spawnCalls = [];
let Streamlink;

function makeConfig(overrides = {}) {
  return {
    streamlinkQuality: 'audio_only,worst',
    ...overrides
  };
}

before(async (ctx) => {
  spawnCalls = [];
  // Mock our own ChildProcess base class (a collaborator of Streamlink)
  // rather than spawning the real binary; the base is tested for real in
  // childProcessNew.test.js.
  ctx.mock.module('../src/childProcess.js', {
    exports: { ChildProcess: createFakeChildProcessBase({ spawnCalls }) }
  });
  ({ Streamlink } = await import('../src/streamlink.js'));
});

describe('Streamlink', () => {
  test('constructs without arguments', () => {
    assert.doesNotThrow(() => new Streamlink());
  });

  test('spawns streamlink with default-stream and output args (no proxy)', () => {
    spawnCalls.length = 0;
    const streamlink = new Streamlink(makeConfig());

    streamlink.spawnProcess('https://youtube.com/watch?v=abc');

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, 'streamlink');
    assert.deepEqual(spawnCalls[0].args, [
      '--default-stream',
      'audio_only,worst',
      '--output',
      '-',
      'https://youtube.com/watch?v=abc'
    ]);
    assert.deepEqual(spawnCalls[0].stdio, ['ignore', 'pipe', 'pipe']);
  });

  test('spawns through the caller-chosen proxy', () => {
    spawnCalls.length = 0;
    const streamlink = new Streamlink(makeConfig());

    streamlink.spawnProcess('https://youtube.com/watch?v=abc', 'http://user:pass@proxy:3128');

    const args = spawnCalls[0].args;
    const proxyIndex = args.indexOf('--http-proxy');
    assert.notEqual(proxyIndex, -1);
    assert.equal(args[proxyIndex + 1], 'http://user:pass@proxy:3128');
  });
});

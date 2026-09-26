import { describe, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChildProcessBase } from './helpers.js';

const SOURCE_URL = 'icecast://source:testsource@icecast:8000/stream';

let spawnCalls = [];
let Ffmpeg;

before(async (ctx) => {
  spawnCalls = [];
  // Mock our own ChildProcess base class (a collaborator of Ffmpeg) rather
  // than spawning the real binary; the base is tested for real in
  // childProcessNew.test.js.
  ctx.mock.module('../src/childProcess.js', {
    exports: { ChildProcess: createFakeChildProcessBase({ spawnCalls }) }
  });
  ({ Ffmpeg } = await import('../src/ffmpeg.js'));
});

describe('Ffmpeg', () => {
  test('spawns ffmpeg with transcode args and the icecast source URL', () => {
    spawnCalls.length = 0;
    const ffmpeg = new Ffmpeg();

    ffmpeg.spawnProcess(SOURCE_URL);

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, 'ffmpeg');
    assert.deepEqual(spawnCalls[0].args, [
      '-i',
      '-',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-content_type',
      'audio/mpeg',
      '-f',
      'mp3',
      SOURCE_URL
    ]);
    assert.deepEqual(spawnCalls[0].stdio, ['pipe', 'ignore', 'pipe']);
  });
});

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createFakeChildProcessBase } from './helpers';
import type { SpawnCall } from './helpers';

const SOURCE_URL = 'icecast://source:testsource@icecast:8000/stream';
const spawnCalls: SpawnCall[] = [];

let Ffmpeg: typeof import('../src/ffmpeg').Ffmpeg;

beforeAll(async () => {
  mock.module('../src/childProcess', () => ({ ChildProcess: createFakeChildProcessBase({ spawnCalls }) }));
  ({ Ffmpeg } = await import('../src/ffmpeg'));
});

describe('Ffmpeg', () => {
  test('spawns ffmpeg with transcode args and the icecast source URL', () => {
    spawnCalls.length = 0;
    const ffmpeg = new Ffmpeg();

    ffmpeg.spawnProcess(SOURCE_URL);

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].cmd).toBe('ffmpeg');
    expect(spawnCalls[0].args).toEqual([
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
    expect(spawnCalls[0].stdio).toEqual(['pipe', 'ignore', 'pipe']);
  });
});

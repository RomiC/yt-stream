import { ChildProcess } from './childProcess.js';

/**
 * Owns the ffmpeg child process. ffmpeg's source (input) is streamlink's
 * stdout, piped into its stdin by the caller; it transcodes that to MP3 and
 * pushes it to the Icecast output URL. One process per instance.
 */
export class Ffmpeg extends ChildProcess {
  constructor() {
    super({ cmd: 'ffmpeg' });
  }

  /**
   * Spawns ffmpeg pushing transcoded audio to `outputUrl`. Knows nothing
   * about its source (streamlink) or Icecast readiness — the caller pipes
   * the source into stdin and verifies the mountpoint. Returns this instance.
   */
  spawnProcess(outputUrl) {
    const args = [
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
      outputUrl
    ];
    this.spawn(args, ['pipe', 'ignore', 'pipe']);
    return this;
  }
}

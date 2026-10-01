import { ChildProcess } from './childProcess';

export class Ffmpeg extends ChildProcess {
  constructor() {
    super({ cmd: 'ffmpeg' });
  }

  spawnProcess(outputUrl: string): this {
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

import { ChildProcess } from './childProcess';

export interface StreamlinkOptions {
  streamlinkQuality?: string;
}

export class Streamlink extends ChildProcess {
  #streamlinkQuality: string | undefined;

  constructor({ streamlinkQuality }: StreamlinkOptions = {}) {
    super({ cmd: 'streamlink' });
    this.#streamlinkQuality = streamlinkQuality;
  }

  spawnProcess(youtubeUrl: string, proxy: string | null = null): this {
    const args = ['--default-stream', this.#streamlinkQuality ?? '', '--output', '-'];
    if (proxy) {
      args.push('--http-proxy', proxy);
    }
    args.push(youtubeUrl);

    this.spawn(args, ['ignore', 'pipe', 'pipe']);
    return this;
  }
}

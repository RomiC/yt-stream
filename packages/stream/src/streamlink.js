import { ChildProcess } from './childProcess.js';

/**
 * Owns the streamlink child process: fetches the YouTube stream (optionally
 * through the caller-chosen proxy) and writes raw media to stdout, which is
 * piped into ffmpeg's stdin. One process at a time; spawnProcess replaces
 * any previous process. Proxy selection policy lives in the pipeline.
 */
export class Streamlink extends ChildProcess {
  #streamlinkQuality;

  constructor({ streamlinkQuality } = {}) {
    super({ cmd: 'streamlink' });
    this.#streamlinkQuality = streamlinkQuality;
  }

  /** Spawns streamlink through `proxy` (null = direct connection). */
  async spawnProcess(youtubeUrl, proxy = null) {
    const args = ['--default-stream', this.#streamlinkQuality, '--output', '-'];
    if (proxy) {
      args.push('--http-proxy', proxy);
    }
    args.push(youtubeUrl);

    await this.spawn(args, ['ignore', 'pipe', 'pipe']);
    return this;
  }
}

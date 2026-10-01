import type { HealthStatus, StreamStatus } from './status';

export interface StatusSource {
  getStatus(): Promise<StreamStatus>;
}

export class StatusReport {
  #stream: StatusSource;

  constructor({ stream }: { stream: StatusSource }) {
    this.#stream = stream;
  }

  async getStatus(): Promise<HealthStatus> {
    const status = await this.#stream.getStatus();
    const healthy =
      status.icecast.status === 'available' &&
      (status.general.state !== 'streaming' ||
        (status.streamlink.status === 'running' &&
          status.ffmpeg.status === 'running' &&
          status.icecast.state === 'streaming'));

    return {
      ...status,
      general: { ...status.general, health: healthy ? 'ok' : 'failure' }
    };
  }
}

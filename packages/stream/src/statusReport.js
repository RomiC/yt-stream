/**
 * Builds the /api/state snapshot: the stream status plus an ok/failure verdict.
 */
export class StatusReport {
  #stream;

  constructor({ stream }) {
    this.#stream = stream;
  }

  async getStatus() {
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

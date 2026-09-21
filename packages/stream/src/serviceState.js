/**
 * Returns stream service state
 */
export class ServiceState {
  #streamService;

  constructor({ streamService }) {
    this.#streamService = streamService;
  }

  async getStatus() {
    const status = await this.#streamService.getStatus();
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

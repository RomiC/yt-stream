import { Check } from './check.js';
import { DEFAULT_CHECK_TIMEOUT } from './config.js';

export class StreamCheck extends Check {
  /**
   * @type {string}
   */
  #url;

  /**
   * Create a new StreamCheck instance.
   * @param {string} host - The host of the stream server.
   * @param {number} port - The port of the stream server.
   */
  constructor(host, port) {
    super();
    this.#url = `http://${host}:${port}/api/state`;
  }

  async performCheck() {
    const response = await fetch(this.#url, {
      signal: AbortSignal.timeout(DEFAULT_CHECK_TIMEOUT)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}

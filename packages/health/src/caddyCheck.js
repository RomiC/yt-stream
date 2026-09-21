import { Check } from './check.js';
import { DEFAULT_CHECK_TIMEOUT } from './config.js';

export class CaddyCheck extends Check {
  /**
   * @type {string}
   */
  #url;

  /**
   * Create a new CaddyCheck instance.
   * @param {string} host - The host of the Caddy server.
   * @param {number} port - The port of the Caddy server.
   */
  constructor(host, port) {
    super();
    this.#url = `http://${host}:${port}/hc`;
  }

  async performCheck() {
    const response = await fetch(this.#url, { signal: AbortSignal.timeout(DEFAULT_CHECK_TIMEOUT) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}

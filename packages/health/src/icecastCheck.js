import { Check } from './check.js';
import { DEFAULT_CHECK_TIMEOUT } from './config.js';

export class IcecastCheck extends Check {
  /**
   * @type {string}
   */
  #url;
  /**
   * @type {object}
   * @property {string} Authorization - The authorization header for the request.
   */
  #authHeader;

  /**
   * Create a new IcecastCheck instance.
   * @param {string} host - The host of the Icecast server.
   * @param {number} port - The port of the Icecast server.
   * @param {string} adminPassword - The admin password for authentication.
   */
  constructor(host, port, adminPassword) {
    super();
    this.#url = `http://${host}:${port}/admin/stats`;
    this.#authHeader = {
      Authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}`
    };
  }

  async performCheck() {
    const response = await fetch(this.#url, {
      headers: this.#authHeader,
      signal: AbortSignal.timeout(DEFAULT_CHECK_TIMEOUT)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}

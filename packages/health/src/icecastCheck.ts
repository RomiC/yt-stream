import { Check } from './check';
import { DEFAULT_CHECK_TIMEOUT } from './config';

export class IcecastCheck extends Check {
  #url: string;
  #authHeader: Record<string, string>;

  constructor(host: string, port: number, adminPassword: string) {
    super();
    this.#url = `http://${host}:${port}/admin/stats`;
    this.#authHeader = {
      Authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}`
    };
  }

  protected async performCheck(): Promise<void> {
    const response = await fetch(this.#url, {
      headers: this.#authHeader,
      signal: AbortSignal.timeout(DEFAULT_CHECK_TIMEOUT)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}

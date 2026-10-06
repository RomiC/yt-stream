import { Check } from './check';
import { DEFAULT_CHECK_TIMEOUT } from './config';

export class StreamCheck extends Check {
  #headers: HeadersInit;
  #url: string;

  constructor(host: string, port: number, apiKey: string) {
    super();
    this.#headers = { Authorization: `Bearer ${apiKey}` };
    this.#url = `http://${host}:${port}/api/state`;
  }

  protected async performCheck(): Promise<void> {
    const response = await fetch(this.#url, {
      headers: this.#headers,
      signal: AbortSignal.timeout(DEFAULT_CHECK_TIMEOUT)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}

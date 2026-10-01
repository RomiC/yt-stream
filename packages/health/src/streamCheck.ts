import { Check } from './check';
import { DEFAULT_CHECK_TIMEOUT } from './config';

export class StreamCheck extends Check {
  #url: string;

  constructor(host: string, port: number) {
    super();
    this.#url = `http://${host}:${port}/api/state`;
  }

  protected async performCheck(): Promise<void> {
    const response = await fetch(this.#url, { signal: AbortSignal.timeout(DEFAULT_CHECK_TIMEOUT) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}

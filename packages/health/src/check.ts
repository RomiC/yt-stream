export interface CheckResult {
  result: 'ok' | 'error';
  duration: number;
  error?: string;
}

export interface Checker {
  check(): Promise<CheckResult>;
}

export abstract class Check implements Checker {
  protected abstract performCheck(): Promise<void>;

  async check(): Promise<CheckResult> {
    const timeStart = Date.now();
    let result: 'ok' | 'error' = 'ok';
    let error: string | undefined;

    try {
      await this.performCheck();
    } catch (err) {
      result = 'error';
      error = err instanceof Error ? err.message : String(err);
    }

    const duration = Date.now() - timeStart;
    return error === undefined ? { result, duration } : { result, duration, error };
  }
}

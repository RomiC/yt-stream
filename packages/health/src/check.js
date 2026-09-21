export class Check {
  performCheck() {
    throw new Error('performCheck() not implemented');
  }

  async check() {
    const timeStart = Date.now();
    let result = 'ok';
    let error = null;

    try {
      await this.performCheck();
    } catch (err) {
      result = 'error';
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      result,
      duration: Date.now() - timeStart,
      ...(error ? { error } : {})
    };
  }
}

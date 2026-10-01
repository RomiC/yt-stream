import { spyOn } from 'bun:test';

/** Installs a `globalThis.fetch` spy that stays pending until the test drives `control`. */
export function deferredFetch() {
  const control: { resolve?: (response: Response) => void; reject?: (error: Error) => void } = {};
  const spy = spyOn(globalThis, 'fetch').mockImplementation(
    (() =>
      new Promise<Response>((resolve, reject) => {
        control.resolve = resolve;
        control.reject = reject;
      })) as unknown as typeof fetch
  );

  return { spy, control };
}

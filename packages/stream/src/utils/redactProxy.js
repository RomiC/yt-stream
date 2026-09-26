/**
 * Rebuilds a proxy URL from protocol + host — credentials (and any
 * path/query) are gone by construction; a scheme-default port normalizes away.
 */
export function redactProxy(proxy) {
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.host}`;
  } catch {
    return proxy;
  }
}

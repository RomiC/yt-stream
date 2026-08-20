import { readFile } from 'fs/promises';

function isValidProxyUrl(p) {
  try {
    const u = new URL(p);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Reads a user-provided proxy list file (a JSON array of proxy URL strings,
 * e.g. ["https://user:pass@host:port", ...]) and exposes it to the stream
 * manager, which passes a proxy to streamlink's --http-proxy.
 */
export function createProxyList({ config, logger }) {
  async function listProxies() {
    try {
      const raw = await readFile(config.proxyFile, 'utf-8');
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        p => typeof p === 'string' && p.trim() !== '' && isValidProxyUrl(p),
      );
    } catch (err) {
      logger.warn({ err: err.message }, 'proxy list unavailable — using no proxies');
      return [];
    }
  }

  async function isReady() {
    return (await listProxies()).length > 0;
  }

  return { listProxies, isReady };
}

import config from './config.js';

const ICE_URL = `http://${config.icecast.host}:${config.icecast.port}/admin/listmounts`;
const AUTH = Buffer.from(`admin:${config.icecast.adminPassword}`).toString('base64');
const POLL_INTERVAL = 15_000;
const MOUNTPOINT = '/stream';

let status = { icecastReachable: false, mountpointActive: false, listeners: 0 };

function parseListeners(xml) {
  // Look for the /stream mountpoint block and extract listener count.
  // Icecast admin XML is simple and stable — regex is sufficient.
  const mountRegex = new RegExp(
    `<source\\s[^>]*mount="${MOUNTPOINT}"[^>]*>([\\s\\S]*?)</source>`,
    'i',
  );
  const mountMatch = xml.match(mountRegex);
  if (!mountMatch) return { mountpointActive: false, listeners: 0 };

  const listenersMatch = mountMatch[1].match(/<listeners>(\d+)<\/listeners>/i);
  return {
    mountpointActive: true,
    listeners: listenersMatch ? parseInt(listenersMatch[1], 10) : 0,
  };
}

async function poll(logger) {
  try {
    const res = await fetch(ICE_URL, {
      headers: { Authorization: `Basic ${AUTH}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseListeners(await res.text());
    status = { icecastReachable: true, ...parsed };
  } catch (err) {
    status = { icecastReachable: false, mountpointActive: false, listeners: 0 };
    logger.warn({ err: err.message }, 'icecast poll failed');
  }
}

export function startPolling(logger) {
  poll(logger);
  const interval = setInterval(() => poll(logger), POLL_INTERVAL);
  return {
    getStatus: () => ({ ...status }),
    stop: () => clearInterval(interval),
  };
}

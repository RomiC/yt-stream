export function isValidYoutubeUrl(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    return false;
  }
  const hostname = url.hostname.replace(/^www\./, '');
  if (hostname !== 'youtube.com' && hostname !== 'youtu.be') {
    return false;
  }

  if (hostname === 'youtube.com' && url.pathname === '/watch') {
    const ids = url.searchParams.getAll('v');
    return ids.length === 1 && ids[0].length === 11 && !/[^A-Za-z0-9_-]/.test(ids[0]);
  }

  const path = hostname === 'youtu.be' ? /^\/[A-Za-z0-9_-]{11}\/?$/ : /^\/(?:live|shorts)\/[A-Za-z0-9_-]{11}\/?$/;
  return path.test(url.pathname);
}

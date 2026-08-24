const YOUTUBE_URL_RE = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/|shorts\/)|youtu\.be\/)[\w-]+/;

/**
 * Accepts only plain HTTP(S) URLs on youtube.com / youtu.be with a video id.
 * Rejects IPs, `@`-tricks and other domains — this is the SSRF guard's core
 * (PRD §3.5).
 */
export function isValidYoutubeUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  return YOUTUBE_URL_RE.test(url);
}

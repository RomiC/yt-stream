const YOUTUBE_URL = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/|shorts\/)|youtu\.be\/)[\w-]+/;

export function isValidYoutubeUrl(url: unknown): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }
  return YOUTUBE_URL.test(url);
}

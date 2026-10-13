import { isValidYoutubeUrl } from './isValidYoutubeUrl';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface YoutubeSource {
  videoId: string;
  url: string;
}

export class InvalidYoutubeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidYoutubeSourceError';
  }
}

export function resolveYoutubeSource(params: URLSearchParams): YoutubeSource | null {
  const urls = params.getAll('url');
  const videoIds = params.getAll('video_id');

  if (urls.length === 0 && videoIds.length === 0) {
    return null;
  }
  if (urls.length + videoIds.length !== 1) {
    throw new InvalidYoutubeSourceError('Provide exactly one url or video_id parameter');
  }

  const fromUrl = urls.length === 1;
  const videoId = fromUrl ? extractVideoId(urls[0]) : videoIds[0];

  if (!videoId || videoId.length !== 11 || !VIDEO_ID.test(videoId)) {
    throw new InvalidYoutubeSourceError(fromUrl ? 'Invalid YouTube URL' : 'Invalid YouTube video ID');
  }

  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

function extractVideoId(value: string): string | null {
  if (!isValidYoutubeUrl(value) || value.trim() !== value || /[\r\n\t]/.test(value)) {
    return null;
  }

  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtube.com' && url.pathname === '/watch') {
    const ids = url.searchParams.getAll('v');
    return ids.length === 1 ? ids[0] : null;
  }

  const path = host === 'youtu.be' ? /^\/([^/]+)\/?$/ : /^\/(?:live|shorts)\/([^/]+)\/?$/;
  return url.pathname.match(path)?.[1] ?? null;
}

import { getYoutubeVideoId } from './getYoutubeVideoId';
import { isValidYoutubeUrl } from './isValidYoutubeUrl';

export class InvalidYoutubeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidYoutubeSourceError';
  }
}

export function resolveYoutubeSource(params: URLSearchParams): string | null {
  const urls = params.getAll('url');
  const videoIds = params.getAll('video_id');

  if (urls.length === 0 && videoIds.length === 0) {
    return null;
  }
  if (urls.length + videoIds.length !== 1) {
    throw new InvalidYoutubeSourceError('Provide exactly one url or video_id parameter');
  }

  if (urls.length === 1) {
    if (!isValidYoutubeUrl(urls[0])) {
      throw new InvalidYoutubeSourceError('Invalid YouTube URL');
    }
    return getYoutubeVideoId(urls[0]);
  }

  const videoId = videoIds[0];
  if (videoId.length !== 11 || /[^A-Za-z0-9_-]/.test(videoId)) {
    throw new InvalidYoutubeSourceError('Invalid YouTube video ID');
  }
  return videoId;
}

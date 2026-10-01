export interface YoutubeMeta {
  title: string;
  author_name: string;
  [key: string]: unknown;
}

const YOUTUBE_OEMBED_URL = 'https://www.youtube.com/oembed';

export async function getYoutubeMeta(youtubeUrl: string): Promise<YoutubeMeta | null> {
  try {
    const params = new URLSearchParams({
      url: youtubeUrl,
      format: 'json'
    });
    const res = await fetch(`${YOUTUBE_OEMBED_URL}?${params}`, { signal: AbortSignal.timeout(5_000) });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as YoutubeMeta;
  } catch {
    return null;
  }
}

const YOUTUBE_OEMBED_URL = 'https://www.youtube.com/oembed';

/**
 * @typedef YoutubeMeta
 * @type {object}
 * @property {string} title - The stream's title
 * @property {string} author_name - The author's name
 * @property {string} author_url - Link to the author's channel on Youtube
 * @property {string} type - Stream type (most likely be a video),
 * @property {number} height - The height (of what?)
 * @property {number} width - The width (of what?)
 * @property {string} version - The version
 * @property {string} provider_name - Provider's name ("YouTube"),
 * @property {string} provider_url  - Provider's URL ("https://www.youtube.com/")
 * @property {number} thumbnail_height - Thumbnail's height
 * @property {number} thumbnail_width - Thumbnail's width
 * @property {string} thumbnail_url - Thumbnail's URL
 * @property {string} html - HTML to embded
 */

/**
 *
 * @param {string} youtubeUrl A full Youtube URL (i.e. https://www.youtube.com/live/JD-kMIpDfnY)
 * @returns {Promise<(YoutubeMeta|null)>}
 */
export async function getYoutubeMeta(youtubeUrl) {
  try {
    const params = new URLSearchParams({
      url: youtubeUrl,
      format: 'json'
    });
    const res = await fetch(`${YOUTUBE_OEMBED_URL}?${params}`, { signal: AbortSignal.timeout(5_000) });

    if (!res.ok) {
      return null;
    }

    return await res.json();
  } catch {
    return null;
  }
}

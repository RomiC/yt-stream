import { describe, expect, spyOn, test } from 'bun:test';
import { getYoutubeMeta } from '../../src/utils/getYoutubeMeta';

const URL_UNDER_TEST = 'https://www.youtube.com/live/JD-kMIpDfnY';
const OEMBED_URL = 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Flive%2FJD-kMIpDfnY&format=json';

function mockFetch(implementation: () => Promise<Response>) {
  return spyOn(globalThis, 'fetch').mockImplementation(implementation as unknown as typeof fetch);
}

describe('getYoutubeMeta', () => {
  test('fetches and returns the oEmbed metadata', async () => {
    const meta = {
      title: 'lofi hip hop radio',
      author_name: 'Lofi Girl',
      type: 'video',
      version: '1.0',
      provider_name: 'YouTube',
      thumbnail_height: 360,
      thumbnail_width: 480,
      thumbnail_url: 'https://i.ytimg.com/vi/JD-kMIpDfnY/hqdefault.jpg'
    };
    const spy = mockFetch(async () => Response.json(meta));

    const result = await getYoutubeMeta(URL_UNDER_TEST);

    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0][0]).toBe(OEMBED_URL);
    expect(result).toEqual(meta);

    spy.mockRestore();
  });

  test('returns null when the request fails', async () => {
    const spy = mockFetch(async () => {
      throw new Error('Bad request');
    });

    expect(await getYoutubeMeta(URL_UNDER_TEST)).toBeNull();

    spy.mockRestore();
  });

  test('returns null on a non-ok response', async () => {
    const spy = mockFetch(async () => new Response(null, { status: 500 }));

    expect(await getYoutubeMeta(URL_UNDER_TEST)).toBeNull();

    spy.mockRestore();
  });

  test('returns null when JSON parsing fails', async () => {
    const spy = mockFetch(async () => new Response('not json', { status: 200 }));

    expect(await getYoutubeMeta(URL_UNDER_TEST)).toBeNull();

    spy.mockRestore();
  });
});

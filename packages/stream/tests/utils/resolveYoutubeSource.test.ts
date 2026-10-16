import { describe, expect, test } from 'bun:test';
import { InvalidYoutubeSourceError, resolveYoutubeSource } from '../../src/utils/resolveYoutubeSource';

const VIDEO_ID = 'r_SV26dPwuA';
const URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

describe('resolveYoutubeSource', () => {
  test.each(['', 'key=secret', 'other=value', 'key=secret&other=value'])(
    '%s without a source returns null',
    (query) => {
      expect(resolveYoutubeSource(new URLSearchParams(query))).toBeNull();
    }
  );

  test('resolves a bare video ID and ignores unrelated parameters', () => {
    expect(resolveYoutubeSource(new URLSearchParams({ video_id: VIDEO_ID, key: 'secret', other: 'value' }))).toBe(
      VIDEO_ID
    );
  });

  test.each([
    `https://youtube.com/watch?v=${VIDEO_ID}`,
    URL,
    `http://youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com/live/${VIDEO_ID}`,
    `https://www.youtube.com/live/${VIDEO_ID}`,
    `https://youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/shorts/${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}`,
    `https://www.youtu.be/${VIDEO_ID}`,
    `http://youtu.be/${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}/`,
    `https://youtube.com/live/${VIDEO_ID}/`,
    `https://youtube.com/shorts/${VIDEO_ID}/`,
    `https://youtube.com/watch?v=${VIDEO_ID}&t=90&start=10&list=playlist&si=tracking#fragment`,
    `https://youtube.com/watch?si=tracking&v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?t=90&si=tracking#fragment`,
    `https://youtube.com/live/${VIDEO_ID}?t=90`,
    `https://youtube.com/shorts/${VIDEO_ID}?si=tracking`
  ])('resolves %s to the same video ID', (url) => {
    expect(resolveYoutubeSource(new URLSearchParams({ url }))).toBe(VIDEO_ID);
  });

  test('preserves video ID case rather than merging distinct identities', () => {
    const lowerId = VIDEO_ID.toLowerCase();
    const upperId = VIDEO_ID.toUpperCase();

    expect(resolveYoutubeSource(new URLSearchParams({ video_id: lowerId }))).toBe(lowerId);
    expect(resolveYoutubeSource(new URLSearchParams({ url: `https://youtu.be/${upperId}` }))).toBe(upperId);
    expect(lowerId).not.toBe(upperId);
  });

  test('accepts all allowed video ID characters', () => {
    expect(resolveYoutubeSource(new URLSearchParams({ video_id: '-_012345678' }))).toBe('-_012345678');
  });

  describe('source selection', () => {
    test.each([
      `url=${encodeURIComponent(URL)}&video_id=${VIDEO_ID}`,
      'url=&video_id=',
      `url=${encodeURIComponent(URL)}&video_id=`,
      `url=&video_id=${VIDEO_ID}`,
      `url=${encodeURIComponent(URL)}&url=${encodeURIComponent(URL)}`,
      `video_id=${VIDEO_ID}&video_id=${VIDEO_ID}`,
      `url=${encodeURIComponent(URL)}&%75rl=${encodeURIComponent(URL)}`,
      `video_id=${VIDEO_ID}&video%5Fid=${VIDEO_ID}`
    ])('rejects conflicting or repeated parameters: %s', (query) => {
      expect(() => resolveYoutubeSource(new URLSearchParams(query))).toThrow(
        'Provide exactly one url or video_id parameter'
      );
    });

    test('has a distinct validation error type for future API handling', () => {
      expect(() => resolveYoutubeSource(new URLSearchParams({ video_id: '' }))).toThrow(InvalidYoutubeSourceError);
    });
  });

  describe('video ID validation', () => {
    test.each([
      '',
      'abc123',
      VIDEO_ID.slice(0, -1),
      `${VIDEO_ID}x`,
      ` ${VIDEO_ID}`,
      `${VIDEO_ID} `,
      `${VIDEO_ID}\n`,
      `${VIDEO_ID}\r`,
      `${VIDEO_ID}\t`,
      'r_SV26dPwu.',
      'r_SV26dPwu/',
      'r_SV26dPwué',
      `%72_SV26dPwuA`,
      URL
    ])('rejects invalid bare ID %j', (videoId) => {
      expect(() => resolveYoutubeSource(new URLSearchParams({ video_id: videoId }))).toThrow(
        'Invalid YouTube video ID'
      );
    });
  });

  describe('URL validation', () => {
    test.each([
      '',
      'not-a-url',
      `https://youtube.com/watch?v=${VIDEO_ID.slice(0, -1)}`,
      `https://youtube.com/watch?v=${VIDEO_ID}x`,
      `https://youtube.com/watch?v=${VIDEO_ID}%2Fextra`,
      `https://youtube.com/watch?v=${VIDEO_ID}%0A`,
      `https://youtube.com/watch?v=${VIDEO_ID}&v=${VIDEO_ID}`,
      `https://youtube.com/watch?v=${VIDEO_ID}&v=`,
      `https://youtube.com/watch?v=${VIDEO_ID}&%76=${VIDEO_ID}`,
      `https://youtu.be/${VIDEO_ID}x`,
      `https://youtube.com/live/${VIDEO_ID}.html`,
      `https://youtube.com/shorts/${VIDEO_ID}!`,
      `https://youtu.be/${VIDEO_ID}/extra`,
      `https://youtube.com/live/${VIDEO_ID}/extra`,
      `https://youtube.com/shorts/${VIDEO_ID}/extra`,
      `https://youtu.be/watch?v=${VIDEO_ID}`,
      `https://youtu.be/live/${VIDEO_ID}`,
      `https://youtube.com/embed/${VIDEO_ID}`,
      `https://youtube.com/?v=${VIDEO_ID}`,
      `https://m.youtube.com/watch?v=${VIDEO_ID}`,
      `https://example.com/watch?v=${VIDEO_ID}`,
      `https://youtube.com.evil.com/watch?v=${VIDEO_ID}`,
      `https://youtube.com@evil.com/watch?v=${VIDEO_ID}`,
      `https://user:pass@youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtube.com:8443/watch?v=${VIDEO_ID}`,
      `http://youtube.com:8080/watch?v=${VIDEO_ID}`,
      `https://youtu.be:8443/${VIDEO_ID}`,
      `https://127.0.0.1/watch?v=${VIDEO_ID}`,
      `ftp://youtube.com/watch?v=${VIDEO_ID}`,
      `file:///etc/passwd`,
      `javascript:alert(1)`,
      `//youtube.com/watch?v=${VIDEO_ID}`
    ])('rejects malformed or unsupported URL %j', (url) => {
      expect(() => resolveYoutubeSource(new URLSearchParams({ url }))).toThrow('Invalid YouTube URL');
    });
  });
});

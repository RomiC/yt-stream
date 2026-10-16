import { describe, expect, test } from 'bun:test';
import { isValidYoutubeUrl } from '../../src/utils/isValidYoutubeUrl';

const VIDEO_ID = 'r_SV26dPwuA';

describe('isValidYoutubeUrl', () => {
  test.each([
    `https://youtube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `http://youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com/live/${VIDEO_ID}`,
    `https://youtube.com/shorts/${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}`,
    `https://www.youtu.be/${VIDEO_ID}`,
    `https://youtube.com/live/${VIDEO_ID}/`,
    `https://youtube.com/shorts/${VIDEO_ID}/`,
    `https://youtu.be/${VIDEO_ID}/`,
    `https://youtube.com/watch?v=${VIDEO_ID}&t=90#fragment`,
    `https://youtu.be/${VIDEO_ID}?v=other&t=90#fragment`,
    `https://youtube.com/watch?t=90&v=${VIDEO_ID}`,
    `https://youtube.com:443/watch?v=${VIDEO_ID}`,
    `http://youtu.be:80/${VIDEO_ID}`,
    `https://WWW.YOUTUBE.COM/watch?v=${VIDEO_ID}`
  ])('accepts %s', (url) => {
    expect(isValidYoutubeUrl(url)).toBe(true);
  });

  test.each([
    '',
    null,
    undefined,
    123,
    {},
    `https://example.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com.evil.com/watch?v=${VIDEO_ID}`,
    `https://evilyoutube.com/watch?v=${VIDEO_ID}`,
    `https://notyoutube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com@evil.com/watch?v=${VIDEO_ID}`,
    `https://evil.com@youtube.com/watch?v=${VIDEO_ID}`,
    `https://user:pass@youtube.com/watch?v=${VIDEO_ID}`,
    `ftp://youtube.com/watch?v=${VIDEO_ID}`,
    'file:///etc/passwd',
    'javascript:alert(1)',
    `//youtube.com/watch?v=${VIDEO_ID}`,
    `https://127.0.0.1/watch?v=${VIDEO_ID}`,
    `https://192.168.0.1/watch?v=${VIDEO_ID}`,
    `https://10.0.0.1/watch?v=${VIDEO_ID}`,
    'https://youtube.com/watch?v=',
    'https://youtube.com/',
    'https://youtube.com/watch?v=abc123',
    `https://youtube.com/watch?v=${VIDEO_ID}x`,
    `https://youtu.be/${VIDEO_ID}x`,
    `https://youtube.com/watch?v=${VIDEO_ID}/`,
    `https://youtube.com/watch?v=${VIDEO_ID}?t=90`,
    `https://youtu.be/${VIDEO_ID}&t=90`,
    `https://youtube.com/watch?v=${VIDEO_ID}&v=${VIDEO_ID}`,
    `https://youtube.com/watch?v=${VIDEO_ID}&%76=${VIDEO_ID}`,
    `https://youtube.com:8443/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}/extra`,
    `https://youtube.com/live/${VIDEO_ID}/extra`,
    `https://youtube.com/shorts/${VIDEO_ID}/extra`
  ])('rejects %j', (url) => {
    expect(isValidYoutubeUrl(url)).toBe(false);
  });
});

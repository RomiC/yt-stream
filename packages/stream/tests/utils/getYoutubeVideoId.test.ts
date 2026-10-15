import { describe, expect, test } from 'bun:test';
import { getYoutubeVideoId } from '../../src/utils/getYoutubeVideoId';

const VIDEO_ID = 'r_SV26dPwuA';

describe('getYoutubeVideoId', () => {
  test.each([
    `https://youtube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com/watch?t=90&v=${VIDEO_ID}#fragment`,
    `https://youtu.be/${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}/?t=90`,
    `https://www.youtu.be/${VIDEO_ID}?v=other`,
    `https://youtube.com/live/${VIDEO_ID}`,
    `https://youtube.com/live/${VIDEO_ID}/`,
    `https://youtube.com/shorts/${VIDEO_ID}`,
    `https://youtube.com/shorts/${VIDEO_ID}/`
  ])('extracts the case-preserved ID from a valid URL: %s', (url) => {
    expect(getYoutubeVideoId(url)).toBe(VIDEO_ID);
  });
});

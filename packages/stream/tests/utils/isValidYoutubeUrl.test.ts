import { describe, expect, test } from 'bun:test';
import { isValidYoutubeUrl } from '../../src/utils/isValidYoutubeUrl';

describe('isValidYoutubeUrl', () => {
  test('accepts plain YouTube URLs', () => {
    expect(isValidYoutubeUrl('https://youtube.com/watch?v=abc123')).toBe(true);
    expect(isValidYoutubeUrl('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(isValidYoutubeUrl('https://youtube.com/live/abc123')).toBe(true);
    expect(isValidYoutubeUrl('https://youtube.com/shorts/abc123')).toBe(true);
    expect(isValidYoutubeUrl('https://youtu.be/abc123')).toBe(true);
    expect(isValidYoutubeUrl('http://youtube.com/watch?v=abc123')).toBe(true);
  });

  test('rejects non-YouTube hosts', () => {
    expect(isValidYoutubeUrl('https://example.com/watch?v=abc123')).toBe(false);
    expect(isValidYoutubeUrl('https://youtube.com.evil.com/watch?v=abc123')).toBe(false);
    expect(isValidYoutubeUrl('https://evilyoutube.com/watch?v=abc123')).toBe(false);
    expect(isValidYoutubeUrl('https://notyoutube.com/watch?v=abc123')).toBe(false);
  });

  test('rejects @-tricks and embedded credentials', () => {
    expect(isValidYoutubeUrl('https://youtube.com@evil.com/watch?v=abc123')).toBe(false);
    expect(isValidYoutubeUrl('https://evil.com@youtube.com/watch?v=abc123')).toBe(false);
    expect(isValidYoutubeUrl('https://user:pass@youtube.com/watch?v=abc123')).toBe(false);
  });

  test('rejects non-HTTP schemes', () => {
    expect(isValidYoutubeUrl('ftp://youtube.com/watch?v=abc123')).toBe(false);
    expect(isValidYoutubeUrl('file:///etc/passwd')).toBe(false);
    expect(isValidYoutubeUrl('javascript:alert(1)')).toBe(false);
    expect(isValidYoutubeUrl('//youtube.com/watch?v=abc123')).toBe(false);
  });

  test('rejects IP addresses', () => {
    expect(isValidYoutubeUrl('https://127.0.0.1/watch?v=abc123')).toBe(false);
    expect(isValidYoutubeUrl('https://192.168.0.1/watch?v=abc123')).toBe(false);
    expect(isValidYoutubeUrl('https://10.0.0.1/watch?v=abc123')).toBe(false);
  });

  test('rejects malformed input', () => {
    expect(isValidYoutubeUrl('')).toBe(false);
    expect(isValidYoutubeUrl(null)).toBe(false);
    expect(isValidYoutubeUrl(undefined)).toBe(false);
    expect(isValidYoutubeUrl(123)).toBe(false);
    expect(isValidYoutubeUrl({})).toBe(false);
    expect(isValidYoutubeUrl('https://youtube.com/watch?v=')).toBe(false);
    expect(isValidYoutubeUrl('https://youtube.com/')).toBe(false);
  });
});

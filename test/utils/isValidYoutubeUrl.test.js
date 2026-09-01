import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidYoutubeUrl } from '../../src/utils/isValidYoutubeUrl.js';

describe('isValidYoutubeUrl', () => {
  test('accepts plain YouTube URLs', () => {
    assert.equal(isValidYoutubeUrl('https://youtube.com/watch?v=abc123'), true);
    assert.equal(isValidYoutubeUrl('https://www.youtube.com/watch?v=abc123'), true);
    assert.equal(isValidYoutubeUrl('https://youtube.com/live/abc123'), true);
    assert.equal(isValidYoutubeUrl('https://youtube.com/shorts/abc123'), true);
    assert.equal(isValidYoutubeUrl('https://youtu.be/abc123'), true);
    assert.equal(isValidYoutubeUrl('http://youtube.com/watch?v=abc123'), true);
  });

  test('rejects non-YouTube hosts', () => {
    assert.equal(isValidYoutubeUrl('https://example.com/watch?v=abc123'), false);
    assert.equal(isValidYoutubeUrl('https://youtube.com.evil.com/watch?v=abc123'), false);
    assert.equal(isValidYoutubeUrl('https://evilyoutube.com/watch?v=abc123'), false);
    assert.equal(isValidYoutubeUrl('https://notyoutube.com/watch?v=abc123'), false);
  });

  test('rejects @-tricks and embedded credentials', () => {
    assert.equal(isValidYoutubeUrl('https://youtube.com@evil.com/watch?v=abc123'), false);
    assert.equal(isValidYoutubeUrl('https://evil.com@youtube.com/watch?v=abc123'), false);
    assert.equal(isValidYoutubeUrl('https://user:pass@youtube.com/watch?v=abc123'), false);
  });

  test('rejects non-HTTP schemes', () => {
    assert.equal(isValidYoutubeUrl('ftp://youtube.com/watch?v=abc123'), false);
    assert.equal(isValidYoutubeUrl('file:///etc/passwd'), false);
    assert.equal(isValidYoutubeUrl('javascript:alert(1)'), false);
    assert.equal(isValidYoutubeUrl('//youtube.com/watch?v=abc123'), false);
  });

  test('rejects IP addresses', () => {
    assert.equal(isValidYoutubeUrl('https://127.0.0.1/watch?v=abc123'), false);
    assert.equal(isValidYoutubeUrl('https://192.168.0.1/watch?v=abc123'), false);
    assert.equal(isValidYoutubeUrl('https://10.0.0.1/watch?v=abc123'), false);
  });

  test('rejects malformed input', () => {
    assert.equal(isValidYoutubeUrl(''), false);
    assert.equal(isValidYoutubeUrl(null), false);
    assert.equal(isValidYoutubeUrl(undefined), false);
    assert.equal(isValidYoutubeUrl(123), false);
    assert.equal(isValidYoutubeUrl({}), false);
    assert.equal(isValidYoutubeUrl('https://youtube.com/watch?v='), false);
    assert.equal(isValidYoutubeUrl('https://youtube.com/'), false);
  });
});

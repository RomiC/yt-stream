import { before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { getYoutubeMeta } from '../../src/utils/getYoutubeMeta.js';

describe('getYoutubeMeta', () => {
  let fetchMock = mock.fn(() => {
    const { promise, resolve, reject } = Promise.withResolvers();

    fetchMock._resolve = (data) =>
      resolve({
        get ok() {
          return !(data instanceof Error);
        },
        async json() {
          if (data instanceof Error) {
            throw data;
          }
          return Promise.resolve(data);
        }
      });
    fetchMock._reject = reject;

    return promise;
  });

  before(() => {
    mock.property(global, 'fetch', fetchMock);
  });

  beforeEach(() => {
    fetchMock._resolve = null;
    fetchMock._reject = null;
    fetchMock.mock.resetCalls();
  });

  test('should fetch youtube meta and return it', async () => {
    assert.deepEqual(typeof getYoutubeMeta, 'function', 'should be a function');

    const metaResponse = getYoutubeMeta('https://www.youtube.com/live/JD-kMIpDfnY');

    assert.deepEqual(metaResponse instanceof Promise, true, 'should return Promise');
    assert.deepEqual(fetchMock.mock.callCount(), 1, 'should call fetch');
    assert.deepEqual(
      fetchMock.mock.calls[0].arguments[0],
      'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Flive%2FJD-kMIpDfnY&format=json',
      'should Youtube oembed URL w/ proper parameters'
    );

    fetchMock._resolve({
      title: 'lofi hip hop radio',
      author_name: 'Lofi Girl',
      type: 'video',
      version: '1.0',
      provider_name: 'YouTube',
      thumbnail_height: 360,
      thumbnail_width: 480,
      thumbnail_url: 'https://i.ytimg.com/vi/JD-kMIpDfnY/hqdefault.jpg'
    });

    const meta = await metaResponse;

    assert.deepEqual(
      meta,
      {
        title: 'lofi hip hop radio',
        author_name: 'Lofi Girl',
        type: 'video',
        version: '1.0',
        provider_name: 'YouTube',
        thumbnail_height: 360,
        thumbnail_width: 480,
        thumbnail_url: 'https://i.ytimg.com/vi/JD-kMIpDfnY/hqdefault.jpg'
      },
      'should return fetched data'
    );
  });

  test('should return null if request failed', async () => {
    const metaResponse = getYoutubeMeta('https://www.youtube.com/live/JD-kMIpDfnY');

    assert.deepEqual(fetchMock.mock.callCount(), 1, 'should call fetch');

    fetchMock._reject(new Error('Bad request'));

    const meta = await metaResponse;

    assert.deepEqual(meta, null, 'should return null');
  });

  test('should return null if JSON parsing failed', async () => {
    const metaResponse = getYoutubeMeta('https://www.youtube.com/live/JD-kMIpDfnY');

    assert.deepEqual(fetchMock.mock.callCount(), 1, 'should call fetch');

    fetchMock._resolve(new Error('Failed to parse data!'));

    const meta = await metaResponse;

    assert.deepEqual(meta, null, 'should return null');
  });
});

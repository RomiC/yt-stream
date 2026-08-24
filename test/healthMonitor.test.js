import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthMonitor } from '../src/healthMonitor.js';

describe('HealthMonitor', () => {
  function snapshot(overrides = {}) {
    return {
      streamlink: { status: 'stopped' },
      ffmpeg: { status: 'stopped' },
      icecast: { status: 'available', state: 'stopped' },
      general: { state: 'idle', url: null },
      ...overrides
    };
  }

  function makeMonitor(streamService = { getStatus: async () => snapshot() }) {
    return new HealthMonitor({ streamService });
  }

  test('ok when Icecast is available and no stream is running', async () => {
    const status = await makeMonitor().getStatus();

    assert.equal(status.general.health, 'ok');
    assert.deepEqual(status.general, { state: 'idle', url: null, health: 'ok' });
  });

  test('ok while streaming with all processes running', async () => {
    const monitor = makeMonitor({
      getStatus: async () =>
        snapshot({
          streamlink: { status: 'running' },
          ffmpeg: { status: 'running' },
          icecast: { status: 'available', state: 'streaming' },
          general: { state: 'streaming', url: 'https://youtube.com/watch?v=abc' }
        })
    });

    const status = await monitor.getStatus();

    assert.equal(status.general.health, 'ok');
  });

  test('failure when Icecast is unreachable', async () => {
    const monitor = makeMonitor({
      getStatus: async () =>
        snapshot({
          icecast: { status: 'unavailable', state: 'stopped' }
        })
    });

    const status = await monitor.getStatus();

    assert.equal(status.general.health, 'failure');
  });

  test('failure while streaming when a process is down', async () => {
    const monitor = makeMonitor({
      getStatus: async () =>
        snapshot({
          streamlink: { status: 'running' },
          ffmpeg: { status: 'stopped' },
          icecast: { status: 'available', state: 'streaming' },
          general: { state: 'streaming', url: 'https://youtube.com/watch?v=abc' }
        })
    });

    const status = await monitor.getStatus();

    assert.equal(status.general.health, 'failure');
  });

  test('failure while streaming when the mount is not active', async () => {
    const monitor = makeMonitor({
      getStatus: async () =>
        snapshot({
          streamlink: { status: 'running' },
          ffmpeg: { status: 'running' },
          icecast: { status: 'available', state: 'stopped' },
          general: { state: 'streaming', url: 'https://youtube.com/watch?v=abc' }
        })
    });

    const status = await monitor.getStatus();

    assert.equal(status.general.health, 'failure');
  });
});

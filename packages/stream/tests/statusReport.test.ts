import { describe, expect, test } from 'bun:test';
import { StatusReport } from '../src/statusReport';
import type { StreamStatus } from '../src/status';

function snapshot(overrides: Partial<StreamStatus> = {}): StreamStatus {
  return {
    streamlink: { status: 'stopped' },
    ffmpeg: { status: 'stopped' },
    icecast: { status: 'available', state: 'stopped', listeners: 0 },
    general: { state: 'idle', url: null },
    ...overrides
  };
}

function makeMonitor(status: StreamStatus = snapshot()) {
  return new StatusReport({ stream: { getStatus: async () => status } });
}

describe('StatusReport', () => {
  test('ok when Icecast is available and no stream is running', async () => {
    const status = await makeMonitor().getStatus();

    expect(status.general).toEqual({ state: 'idle', url: null, health: 'ok' });
  });

  test('ok while streaming with all processes running', async () => {
    const monitor = makeMonitor(
      snapshot({
        streamlink: { status: 'running' },
        ffmpeg: { status: 'running' },
        icecast: { status: 'available', state: 'streaming', listeners: 0 },
        general: { state: 'streaming', url: 'https://youtube.com/watch?v=abc' }
      })
    );

    expect((await monitor.getStatus()).general.health).toBe('ok');
  });

  test('failure when Icecast is unreachable', async () => {
    const monitor = makeMonitor(snapshot({ icecast: { status: 'unavailable', state: 'stopped', listeners: 0 } }));

    expect((await monitor.getStatus()).general.health).toBe('failure');
  });

  test('failure while streaming when a process is down', async () => {
    const monitor = makeMonitor(
      snapshot({
        streamlink: { status: 'running' },
        ffmpeg: { status: 'stopped' },
        icecast: { status: 'available', state: 'streaming', listeners: 0 },
        general: { state: 'streaming', url: 'https://youtube.com/watch?v=abc' }
      })
    );

    expect((await monitor.getStatus()).general.health).toBe('failure');
  });

  test('failure while streaming when the mount is not active', async () => {
    const monitor = makeMonitor(
      snapshot({
        streamlink: { status: 'running' },
        ffmpeg: { status: 'running' },
        icecast: { status: 'available', state: 'stopped', listeners: 0 },
        general: { state: 'streaming', url: 'https://youtube.com/watch?v=abc' }
      })
    );

    expect((await monitor.getStatus()).general.health).toBe('failure');
  });
});

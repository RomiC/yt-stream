import { describe, expect, spyOn, test } from 'bun:test';
import { silentLogger } from 'yt-stream-shared';
import { IcecastClient, IcecastUnreachableError } from '../src/icecastClient';

const MOUNT_XML = `<?xml version="1.0"?>
<icestats>
<source mount="/stream">
  <listeners>2</listeners>
</source>
</icestats>`;

const OTHER_MOUNT_XML = `<?xml version="1.0"?>
<icestats>
<source mount="/other">
  <listeners>9</listeners>
</source>
</icestats>`;

const EMPTY_XML = `<?xml version="1.0"?>
<icestats></icestats>`;

function makeIcecast(
  overrides: {
    icecast?: { host: string; port: number; adminPassword?: string; sourcePassword?: string };
    publicBaseUrl?: string;
  } = {},
  timeouts = {}
): IcecastClient {
  const icecast = {
    host: 'icecast',
    port: 8000,
    adminPassword: 'admin',
    sourcePassword: 'secret',
    ...overrides.icecast
  };

  return new IcecastClient({
    host: icecast.host,
    port: icecast.port,
    sourcePassword: icecast.sourcePassword,
    adminPassword: icecast.adminPassword,
    publicBaseUrl: overrides.publicBaseUrl ?? 'http://localhost',
    logger: silentLogger(),
    timeouts
  });
}

function mockFetch(implementation: () => Response | Promise<Response>) {
  return spyOn(globalThis, 'fetch').mockImplementation((async () => implementation()) as unknown as typeof fetch);
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

describe('IcecastClient', () => {
  describe('getStatus', () => {
    test('parses the /stream mountpoint listener count', async () => {
      const spy = mockFetch(() => okResponse(MOUNT_XML));

      expect(await makeIcecast().getStatus()).toEqual({
        icecastReachable: true,
        mountpointActive: true,
        listeners: 2
      });

      spy.mockRestore();
    });

    test('HTTP error marks Icecast unreachable', async () => {
      const spy = mockFetch(() => new Response('', { status: 503 }));

      expect(await makeIcecast().getStatus()).toEqual({
        icecastReachable: false,
        mountpointActive: false,
        listeners: 0
      });

      spy.mockRestore();
    });

    test('network failure marks Icecast unreachable', async () => {
      const spy = mockFetch(() => {
        throw new Error('ECONNREFUSED');
      });

      expect(await makeIcecast().getStatus()).toEqual({
        icecastReachable: false,
        mountpointActive: false,
        listeners: 0
      });

      spy.mockRestore();
    });

    test('mount not present reports inactive', async () => {
      const spy = mockFetch(() => okResponse(OTHER_MOUNT_XML));

      expect(await makeIcecast().getStatus()).toEqual({
        icecastReachable: true,
        mountpointActive: false,
        listeners: 0
      });

      spy.mockRestore();
    });

    test('sends basic auth with the admin password', async () => {
      const spy = mockFetch(() => okResponse(EMPTY_XML));

      await makeIcecast({ icecast: { host: 'ic', port: 8000, adminPassword: 'testadmin' } }).getStatus();

      const init = spy.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from('admin:testadmin').toString('base64')}`
      );

      spy.mockRestore();
    });
  });

  describe('URLs', () => {
    test('sourceUrl and streamUrl getters are derived from config', () => {
      const icecast = makeIcecast({
        icecast: { host: 'ic', port: 8000, sourcePassword: 'icecast-password' },
        publicBaseUrl: 'https://yts.example.com:3001/'
      });

      expect(icecast.sourceUrl).toBe('icecast://source:icecast-password@ic:8000/stream');
      expect(icecast.streamUrl).toBe('https://yts.example.com:3001/stream');
    });
  });

  describe('prepareMountPoint', () => {
    test('resolves immediately when Icecast is up and the mount is free', async () => {
      const spy = mockFetch(() => okResponse(EMPTY_XML));

      await makeIcecast().prepareMountPoint(); // resolves

      spy.mockRestore();
    });

    test('waits for a stale source to release', async () => {
      const bodies = [MOUNT_XML, EMPTY_XML];
      const spy = mockFetch(() => okResponse(bodies.shift() ?? EMPTY_XML));

      await makeIcecast({}, { waitPollInterval: 5, mountpointClearTimeout: 200 }).prepareMountPoint();

      spy.mockRestore();
    });

    test('throws IcecastUnreachableError when Icecast is down', async () => {
      const spy = mockFetch(() => {
        throw new Error('ECONNREFUSED');
      });

      await expect(makeIcecast().prepareMountPoint()).rejects.toBeInstanceOf(IcecastUnreachableError);

      spy.mockRestore();
    });

    test('fails when the mount never releases', async () => {
      const spy = mockFetch(() => okResponse(MOUNT_XML));

      await expect(
        makeIcecast({}, { waitPollInterval: 5, mountpointClearTimeout: 50 }).prepareMountPoint()
      ).rejects.toThrow(/old source still connected to the mountpoint/);

      spy.mockRestore();
    });
  });
});

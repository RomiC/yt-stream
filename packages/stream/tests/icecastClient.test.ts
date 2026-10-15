import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
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

const MULTI_MOUNT_XML = `<icestats>
<source mount="/stream/alphabeta"><listeners>9</listeners></source>
<source mount="/stream/alpha"><listeners>3</listeners></source>
<source mount="/stream/Alpha"><listeners>7</listeners></source>
<source mount="/stream/audioXmp3"><listeners>8</listeners></source>
<source mount="/stream/audio.mp3"><listeners>6</listeners></source>
<source mount="/stream"><listeners>2</listeners></source>
</icestats>`;

const STREAM_MOUNT = '/stream/a7ad2e11-46d3-4b56-bcfa-cc8e673d7842';

afterEach(() => {
  mock.restore();
});

function makeIcecast(
  overrides: {
    icecast?: { host: string; port: number; adminPassword?: string; sourcePassword?: string };
    publicBaseUrl?: string;
    mountpoint?: string;
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
    mountpoint: overrides.mountpoint,
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

  describe('mount-specific clients', () => {
    test('derives both URLs from the selected mountpoint', () => {
      const icecast = makeIcecast({
        mountpoint: STREAM_MOUNT,
        icecast: { host: 'ic', port: 8000, sourcePassword: 'icecast-password' },
        publicBaseUrl: 'https://yts.example.com:3001///'
      });

      expect(icecast.sourceUrl).toBe(`icecast://source:icecast-password@ic:8000${STREAM_MOUNT}`);
      expect(icecast.streamUrl).toBe(`https://yts.example.com:3001${STREAM_MOUNT}`);
    });

    test.each([
      ['/stream', 2],
      ['/stream/alpha', 3],
      ['/stream/alphabeta', 9],
      ['/stream/Alpha', 7],
      ['/stream/audio.mp3', 6]
    ])('reads only %s from a shared mount list', async (mountpoint, listeners) => {
      mockFetch(() => okResponse(MULTI_MOUNT_XML));

      expect(await makeIcecast({ mountpoint }).getStatus()).toEqual({
        icecastReachable: true,
        mountpointActive: true,
        listeners
      });
    });

    test.each(['/stream/missing', '/stream/ALPHA', '/stream/audio-mp3'])(
      '%s is inactive despite other mounts',
      async (mountpoint) => {
        mockFetch(() => okResponse(MULTI_MOUNT_XML));

        expect(await makeIcecast({ mountpoint }).getStatus()).toEqual({
          icecastReachable: true,
          mountpointActive: false,
          listeners: 0
        });
      }
    );

    test('concurrent clients retain independent mount selection', async () => {
      mockFetch(() => okResponse(MULTI_MOUNT_XML));
      const alpha = makeIcecast({ mountpoint: '/stream/alpha' });
      const capitalAlpha = makeIcecast({ mountpoint: '/stream/Alpha' });

      const [first, second] = await Promise.all([alpha.getStatus(), capitalAlpha.getStatus()]);

      expect(first.listeners).toBe(3);
      expect(second.listeners).toBe(7);
      expect((await alpha.getStatus()).listeners).toBe(3);
    });

    test('an active selected mount with no listener count reports zero', async () => {
      mockFetch(() => okResponse('<icestats><source mount="/stream/alpha"></source></icestats>'));

      expect(await makeIcecast({ mountpoint: '/stream/alpha' }).getStatus()).toEqual({
        icecastReachable: true,
        mountpointActive: true,
        listeners: 0
      });
    });

    test('mount preparation ignores occupied unrelated mounts', async () => {
      const spy = mockFetch(() => okResponse(MULTI_MOUNT_XML));

      await makeIcecast({ mountpoint: STREAM_MOUNT }).prepareMountPoint();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('mount preparation completes when only the selected source releases', async () => {
      const bodies = [MULTI_MOUNT_XML, OTHER_MOUNT_XML];
      const spy = mockFetch(() => okResponse(bodies.shift() ?? OTHER_MOUNT_XML));

      await makeIcecast(
        { mountpoint: '/stream/alpha' },
        { waitPollInterval: 5, mountpointClearTimeout: 200 }
      ).prepareMountPoint();

      expect(spy).toHaveBeenCalledTimes(2);
    });

    test('mount preparation still fails while the selected source stays connected', async () => {
      mockFetch(() => okResponse(MULTI_MOUNT_XML));

      await expect(
        makeIcecast(
          { mountpoint: '/stream/alpha' },
          { waitPollInterval: 5, mountpointClearTimeout: 20 }
        ).prepareMountPoint()
      ).rejects.toThrow(/old source still connected to the mountpoint/);
    });

    test.each(['/stream', STREAM_MOUNT, '/stream/Alpha', '/stream/audio.mp3'])(
      'updates metadata only for %s',
      async (mountpoint) => {
        const spy = mockFetch(() => okResponse(''));
        const title = 'Artist - Song & mount=/other';

        expect(await makeIcecast({ mountpoint }).setMetadata(title)).toBe(true);

        const requestUrl = new URL(spy.mock.calls[0][0] as string);
        expect(requestUrl.origin).toBe('http://icecast:8000');
        expect(requestUrl.pathname).toBe('/admin/metadata');
        expect(requestUrl.searchParams.getAll('mount')).toEqual([mountpoint]);
        expect(requestUrl.searchParams.get('mode')).toBe('updinfo');
        expect(requestUrl.searchParams.get('song')).toBe(title);
        const init = spy.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe(
          `Basic ${Buffer.from('admin:admin').toString('base64')}`
        );
      }
    );

    test('metadata remains best-effort on HTTP failure', async () => {
      mockFetch(() => new Response('', { status: 503 }));

      expect(await makeIcecast({ mountpoint: STREAM_MOUNT }).setMetadata('Song')).toBe(false);
    });

    test('metadata remains best-effort on network failure', async () => {
      mockFetch(() => {
        throw new Error('ECONNREFUSED');
      });

      expect(await makeIcecast({ mountpoint: STREAM_MOUNT }).setMetadata('Song')).toBe(false);
    });

    test.each([
      '',
      'stream',
      '/',
      '//stream',
      '/stream/',
      '/stream/./id',
      '/stream/../id',
      '/stream/id?other=mount',
      '/stream/id#fragment',
      '/stream/id%2Fother',
      '/stream/id with spaces',
      '/stream/id"',
      '/stream/id\n',
      'https://example.com/stream'
    ])('rejects unsafe mountpoint %j', (mountpoint) => {
      expect(() => makeIcecast({ mountpoint })).toThrow('Invalid Icecast mountpoint');
    });
  });
});

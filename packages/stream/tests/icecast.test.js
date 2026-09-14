import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Icecast, IcecastUnreachableError } from '../src/icecast.js';
import { silentLogger } from './helpers.js';

describe('Icecast', () => {
  function makeConfig(overrides = {}) {
    return {
      icecast: {
        host: 'icecast',
        port: 8000,
        adminPassword: 'admin',
        sourcePassword: 'secret'
      },
      publicBaseUrl: 'http://localhost',
      ...overrides
    };
  }

  function makeIcecast(overrides = {}, timeouts = {}) {
    const config = makeConfig(overrides);
    return new Icecast({
      host: config.icecast.host,
      port: config.icecast.port,
      sourcePassword: config.icecast.sourcePassword,
      adminPassword: config.icecast.adminPassword,
      publicBaseUrl: config.publicBaseUrl,
      logger: silentLogger(),
      timeouts
    });
  }

  function okResponse(body) {
    return {
      ok: true,
      status: 200,
      text: async () => body
    };
  }

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

  describe('getStatus', () => {
    test('getStatus parses the /stream mountpoint listener count', async (ctx) => {
      ctx.mock.method(globalThis, 'fetch', async () => okResponse(MOUNT_XML));

      const status = await makeIcecast().getStatus();

      assert.deepEqual(status, { icecastReachable: true, mountpointActive: true, listeners: 2 });
    });

    test('HTTP error marks Icecast unreachable', async (ctx) => {
      ctx.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503, text: async () => '' }));

      const status = await makeIcecast().getStatus();

      assert.deepEqual(status, { icecastReachable: false, mountpointActive: false, listeners: 0 });
    });

    test('network failure marks Icecast unreachable', async (ctx) => {
      ctx.mock.method(globalThis, 'fetch', async () => {
        throw new Error('ECONNREFUSED');
      });

      const status = await makeIcecast().getStatus();

      assert.deepEqual(status, { icecastReachable: false, mountpointActive: false, listeners: 0 });
    });

    test('mount not present reports inactive', async (ctx) => {
      ctx.mock.method(globalThis, 'fetch', async () => okResponse(OTHER_MOUNT_XML));

      const status = await makeIcecast().getStatus();

      assert.deepEqual(status, { icecastReachable: true, mountpointActive: false, listeners: 0 });
    });

    test('getStatus sends basic auth with the admin password', async (ctx) => {
      const fetchMock = ctx.mock.method(globalThis, 'fetch', async () => okResponse(EMPTY_XML));
      const icecast = makeIcecast({ icecast: { host: 'ic', port: 8000, adminPassword: 'testadmin' } });

      await icecast.getStatus();

      assert.equal(
        fetchMock.mock.calls[0].arguments[1].headers.Authorization,
        `Basic ${Buffer.from('admin:testadmin').toString('base64')}`
      );
    });
  });
  describe('URLs', () => {
    test('sourceUrl and streamUrl getters are derived from config', () => {
      const icecast = makeIcecast({
        icecast: { host: 'ic', port: 8000, sourcePassword: 'icecast-password' },
        publicBaseUrl: 'https://yts.example.com:3001/'
      });

      assert.equal(icecast.sourceUrl, 'icecast://source:icecast-password@ic:8000/stream');
      assert.equal(icecast.streamUrl, 'https://yts.example.com:3001/stream');
    });
  });
  describe('prepareMountPoint', () => {
    test('prepareMountPoint resolves immediately when Icecast is up and the mount is free', async (ctx) => {
      ctx.mock.method(globalThis, 'fetch', async () => okResponse(EMPTY_XML));

      await makeIcecast().prepareMountPoint(); // resolves
    });

    test('prepareMountPoint waits for a stale source to release', async (ctx) => {
      const bodies = [MOUNT_XML, EMPTY_XML];
      ctx.mock.method(globalThis, 'fetch', async () => okResponse(bodies.shift()));

      await makeIcecast({}, { waitPollInterval: 5, mountpointClearTimeout: 200 }).prepareMountPoint();
    });

    test('prepareMountPoint throws IcecastUnreachableError when Icecast is down', async (ctx) => {
      ctx.mock.method(globalThis, 'fetch', async () => {
        throw new Error('ECONNREFUSED');
      });

      await assert.rejects(makeIcecast().prepareMountPoint(), IcecastUnreachableError);
    });

    test('prepareMountPoint fails when the mount never releases', async (ctx) => {
      ctx.mock.method(globalThis, 'fetch', async () => okResponse(MOUNT_XML));

      await assert.rejects(
        makeIcecast({}, { waitPollInterval: 5, mountpointClearTimeout: 50 }).prepareMountPoint(),
        /old source still connected to the mountpoint/
      );
    });
  });
});

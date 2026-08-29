import { describe, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChildProcessBase, silentLogger } from './helpers.js';

let spawnCalls = [];
let Streamlink;

function makeConfig(overrides = {}) {
  return {
    streamlinkQuality: 'audio_only,worst',
    proxyList: [],
    ...overrides
  };
}

before(async (ctx) => {
  spawnCalls = [];
  // Mock our own ChildProcess base class (a collaborator of Streamlink)
  // rather than node:child_process; the base itself is tested for real in
  // childProcess.test.js.
  ctx.mock.module('../src/childProcess.js', {
    exports: { ChildProcess: createFakeChildProcessBase({ spawnCalls }) }
  });
  ({ Streamlink } = await import('../src/streamlink.js'));
});

describe('Streamlink', () => {
  test('spawns streamlink with default-stream, retry and output args (no proxy)', async () => {
    spawnCalls.length = 0;
    const streamlink = new Streamlink({ config: makeConfig(), logger: silentLogger() });

    await streamlink.spawnProcess('https://youtube.com/watch?v=abc');

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, 'streamlink');
    assert.deepEqual(spawnCalls[0].args, [
      '--default-stream',
      'audio_only,worst',
      '--retry-open',
      '3',
      '--output',
      '-',
      'https://youtube.com/watch?v=abc'
    ]);
    assert.deepEqual(spawnCalls[0].stdio, ['ignore', 'pipe', 'pipe']);
  });

  test('picks a proxy from config.proxyList and adds --http-proxy', async () => {
    spawnCalls.length = 0;
    const proxies = ['http://user:pass@proxy1:3128', 'http://proxy2:3128'];
    const streamlink = new Streamlink({ config: makeConfig({ proxyList: proxies }), logger: silentLogger() });

    await streamlink.spawnProcess('https://youtube.com/watch?v=abc');

    const args = spawnCalls[0].args;
    const proxyIndex = args.indexOf('--http-proxy');
    assert.notEqual(proxyIndex, -1);
    assert.ok(proxies.includes(args[proxyIndex + 1]));
  });

  test('getErrorTail keeps the last stderr output', async () => {
    const streamlink = new Streamlink({ config: makeConfig(), logger: silentLogger() });
    await streamlink.spawnProcess('https://youtube.com/watch?v=abc');
    const first = streamlink.process;

    const secondPromise = streamlink.spawnProcess('https://youtube.com/watch?v=abc');
    first.emitClose(0); // release the replace-kill
    await secondPromise;
    const proc = streamlink.process;

    proc.stderr.emit('data', Buffer.from('line one\n'));
    proc.stderr.emit('data', Buffer.from('line two\n'));

    assert.equal(streamlink.getErrorTail(), 'line one\nline two\n');
  });

  test('kill terminates the current process with SIGTERM', async () => {
    const streamlink = new Streamlink({ config: makeConfig(), logger: silentLogger() });
    await streamlink.spawnProcess('https://youtube.com/watch?v=abc');
    const proc = streamlink.process;

    const killed = streamlink.kill();
    assert.equal(proc.killed, true);
    assert.equal(proc.signal, 'SIGTERM');

    proc.emitClose(0);
    assert.equal(await killed, true);
  });

  test('spawnProcess replaces a running process', async () => {
    const streamlink = new Streamlink({ config: makeConfig(), logger: silentLogger() });
    await streamlink.spawnProcess('https://youtube.com/watch?v=abc');
    const first = streamlink.process;

    const secondPromise = streamlink.spawnProcess('https://youtube.com/watch?v=abc');
    first.emitClose(0); // release the replace-kill
    await secondPromise;
    const second = streamlink.process;

    assert.equal(first.killed, true);
    const killed = streamlink.kill(); // still tracks the current (second) process
    second.emitClose(0);
    assert.equal(await killed, true);
  });

  test('kill on idle resolves false', async () => {
    const streamlink = new Streamlink({ config: makeConfig(), logger: silentLogger() });
    assert.equal(await streamlink.kill(), false);
  });

  test('unexpected close notifies onExit with the exit code', async () => {
    const streamlink = new Streamlink({ config: makeConfig(), logger: silentLogger() });
    const onExit = mock.fn();
    streamlink.onExit(onExit);

    await streamlink.spawnProcess('https://youtube.com/watch?v=abc');
    const proc = streamlink.process;
    proc.emitClose(1);

    assert.equal(streamlink.process, null);
    assert.equal(onExit.mock.callCount(), 1);
    assert.deepEqual(onExit.mock.calls[0].arguments[0], { code: 1, pid: proc.pid });
  });

  test('a deliberate kill does not notify onExit', async () => {
    const streamlink = new Streamlink({ config: makeConfig(), logger: silentLogger() });
    const onExit = mock.fn();
    streamlink.onExit(onExit);

    await streamlink.spawnProcess('https://youtube.com/watch?v=abc');
    const proc = streamlink.process;
    const killed = streamlink.kill();
    proc.emitClose(0);
    await killed;

    assert.equal(onExit.mock.callCount(), 0);
  });
});

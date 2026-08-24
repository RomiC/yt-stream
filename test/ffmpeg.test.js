import { describe, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChildProcessBase, silentLogger } from './helpers.js';
import { EventBus, Event } from '../src/events.js';

const SOURCE_URL = 'icecast://source:testsource@icecast:8000/stream';

let spawnCalls = [];
let Ffmpeg;

before(async (ctx) => {
  spawnCalls = [];
  // Mock our own ChildProcess base class (a collaborator of Ffmpeg) rather
  // than node:child_process; the base itself is tested for real in
  // childProcess.test.js.
  ctx.mock.module('../src/childProcess.js', {
    exports: { ChildProcess: createFakeChildProcessBase({ spawnCalls }) }
  });
  ({ Ffmpeg } = await import('../src/ffmpeg.js'));
});

describe('Ffmpeg', () => {
  test('spawns ffmpeg with transcode args and the icecast source URL', async () => {
    spawnCalls.length = 0;
    const ffmpeg = new Ffmpeg({ logger: silentLogger(), events: new EventBus() });

    await ffmpeg.spawnProcess(SOURCE_URL);

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, 'ffmpeg');
    assert.equal(spawnCalls[0].args[0], '-i');
    assert.equal(spawnCalls[0].args[1], '-');
    assert.ok(spawnCalls[0].args.includes(SOURCE_URL));
    assert.deepEqual(spawnCalls[0].stdio, ['pipe', 'ignore', 'pipe']);
  });

  test('isAlive reflects whether a process is running', async () => {
    const ffmpeg = new Ffmpeg({ logger: silentLogger(), events: new EventBus() });
    assert.equal(ffmpeg.isAlive(), false);

    await ffmpeg.spawnProcess(SOURCE_URL);
    assert.equal(ffmpeg.isAlive(), true);
  });

  test('kill signals SIGTERM, clears the process and resolves on exit', async () => {
    const ffmpeg = new Ffmpeg({ logger: silentLogger(), events: new EventBus() });
    await ffmpeg.spawnProcess(SOURCE_URL);
    const proc = ffmpeg.getProcess();

    const killed = ffmpeg.kill();
    assert.equal(proc.killed, true);
    assert.equal(proc.signal, 'SIGTERM');
    assert.equal(ffmpeg.getProcess(), null);

    proc.emitClose(0);
    assert.equal(await killed, true);
  });

  test('kill on idle resolves false', async () => {
    const ffmpeg = new Ffmpeg({ logger: silentLogger(), events: new EventBus() });
    assert.equal(await ffmpeg.kill(), false);
  });

  test('close clears the process and emits process:exited', async () => {
    const events = new EventBus();
    const onExit = mock.fn();
    events.on(Event.processExited, onExit);
    const ffmpeg = new Ffmpeg({ logger: silentLogger(), events });

    await ffmpeg.spawnProcess(SOURCE_URL);
    const proc = ffmpeg.getProcess();
    proc.emitClose(1);

    assert.equal(ffmpeg.getProcess(), null);
    assert.equal(onExit.mock.callCount(), 1);
    assert.deepEqual(onExit.mock.calls[0].arguments[0], { cmd: 'ffmpeg', code: 1, pid: proc.pid });
  });

  test('process exit after kill does not emit process:exited', async () => {
    const events = new EventBus();
    const onExit = mock.fn();
    events.on(Event.processExited, onExit);
    const ffmpeg = new Ffmpeg({ logger: silentLogger(), events });

    await ffmpeg.spawnProcess(SOURCE_URL);
    const proc = ffmpeg.getProcess();

    const killed = ffmpeg.kill();
    proc.emitClose(0);
    await killed;

    assert.equal(onExit.mock.callCount(), 0);
  });

  test('spawnProcess replaces a running process', async () => {
    const ffmpeg = new Ffmpeg({ logger: silentLogger(), events: new EventBus() });
    await ffmpeg.spawnProcess(SOURCE_URL);
    const first = ffmpeg.getProcess();

    const second = ffmpeg.spawnProcess(SOURCE_URL); // awaits kill(first)
    first.emitClose(0); // resolve the replace-kill
    await second;

    assert.equal(first.killed, true);
    assert.notEqual(ffmpeg.getProcess(), first);
  });
});

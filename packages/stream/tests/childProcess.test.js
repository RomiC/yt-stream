import { describe, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

describe('ChildProcess', () => {
  const KEEP_ALIVE = ['-e', 'setInterval(() => {}, 1000)'];
  const IGNORE_SIGTERM = [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')"
  ];
  const EXIT_NOW = ['-e', ''];

  let FakeTool;

  before(async () => {
    const { ChildProcess } = await import('../src/childProcess.js');

    FakeTool = class extends ChildProcess {
      constructor(options) {
        super({ cmd: process.execPath, ...options });
        this.lastExit = null;
        this.onExit((exit) => {
          this.lastExit = exit;
        });
      }

      // The base class is generic — exercise it against a real, universally
      // available command (the running node binary itself).
      async spawnProcess(args = KEEP_ALIVE, stdio = ['ignore', 'pipe', 'ignore']) {
        return this.spawn(args, stdio);
      }
    };
  });

  test('spawn tracks the running process and returns it', async () => {
    const tool = new FakeTool({});
    const proc = await tool.spawnProcess();

    assert.equal(tool.process, proc);
    await tool.kill(); // cleanup
  });

  test('spawn replaces a running process', async () => {
    const tool = new FakeTool({});
    try {
      const first = await tool.spawnProcess();
      const second = await tool.spawnProcess();

      assert.equal(first.killed, true);
      assert.equal(tool.process, second);
    } finally {
      await tool.kill(); // cleanup
    }
  });

  test('kill resolves true once the process has exited', async () => {
    const tool = new FakeTool({});
    const proc = await tool.spawnProcess();

    const killed = tool.kill();
    assert.equal(proc.killed, true);
    assert.equal(tool.process, null);
    assert.equal(await killed, true);
  });

  test('kill resolves false when idle', async () => {
    const tool = new FakeTool({});
    assert.equal(await tool.kill(), false);
  });

  test('kill resolves false when the process already exited', async () => {
    const tool = new FakeTool({});
    const proc = await tool.spawnProcess(EXIT_NOW);
    await once(proc, 'close');

    assert.equal(await tool.kill(), false);
  });

  test('close clears the process and notifies onExit', async () => {
    const tool = new FakeTool({});
    const proc = await tool.spawnProcess(EXIT_NOW);
    await once(proc, 'close');

    assert.equal(tool.process, null);
    assert.equal(tool.lastExit?.code, 0);
  });

  test('spawn errors fold into the exit payload', async () => {
    const tool = new FakeTool({ cmd: 'definitely-no-such-binary' });
    const proc = await tool.spawnProcess(EXIT_NOW);
    const closed = new Promise((resolve) => proc.on('close', resolve));
    await closed; // events.once() would reject on the expected 'error' event

    assert.match(tool.lastExit.errors, /ENOENT/);
    assert.equal(tool.lastExit?.code, -2);
  });

  test('an externally killed process reports the signal', async () => {
    const tool = new FakeTool({});
    const proc = await tool.spawnProcess(['-e', 'process.kill(process.pid, "SIGKILL")']);
    await once(proc, 'close');

    assert.equal(tool.lastExit?.signal, 'SIGKILL');
    assert.equal(tool.lastExit?.code, null);
  });

  test('stderr survives exit and flows into the exit payload', async () => {
    const tool = new FakeTool({});
    const proc = await tool.spawnProcess(['-e', 'console.error("kaput")'], ['ignore', 'ignore', 'pipe']);
    await once(proc, 'close');

    assert.ok(tool.lastExit.errors.includes('kaput'));
  });

  test('a deliberate kill does not notify onExit', async () => {
    const tool = new FakeTool({});
    await tool.spawnProcess();

    await tool.kill();
    assert.equal(tool.lastExit, null);
  });

  test('SIGKILL fallback fires when the process ignores SIGTERM', async () => {
    const tool = new FakeTool({ sigkillDelayMs: 50 });
    const proc = await tool.spawnProcess(IGNORE_SIGTERM);
    // Wait until the child has booted and registered its SIGTERM handler —
    // otherwise the default (terminate) would fire instead of the fallback.
    await once(proc.stdout, 'data');

    const killed = tool.kill();
    assert.equal(await killed, true);
    assert.equal(proc.signalCode, 'SIGKILL');
  });
});

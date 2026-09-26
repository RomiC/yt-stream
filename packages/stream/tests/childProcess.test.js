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
      spawnProcess(args = KEEP_ALIVE, stdio = ['ignore', 'pipe', 'ignore']) {
        return this.spawn(args, stdio);
      }
    };
  });

  test('spawn tracks the running process and returns the instance for chaining', async () => {
    const tool = new FakeTool({});

    const returned = tool.spawnProcess();

    assert.equal(returned, tool);
    assert.equal(tool.isAlive(), true);
    assert.ok(tool.process.pid > 0);
    await tool.kill(); // cleanup
  });

  test('onExit and spawn chain from the instance', async () => {
    const tool = new FakeTool({});

    const chained = tool.onExit(() => {}).spawnProcess();

    assert.equal(chained, tool);
    assert.equal(tool.isAlive(), true);
    await tool.kill(); // cleanup
  });

  test('a second spawn throws — a new process is a new instance', async () => {
    const tool = new FakeTool({});
    try {
      tool.spawnProcess();
      assert.throws(() => tool.spawnProcess(), /already spawned/);
    } finally {
      await tool.kill(); // cleanup
    }
  });

  test('kill resolves true once the process has fully exited', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess();
    const proc = tool.process;

    const killed = tool.kill();
    assert.equal(proc.killed, true);
    assert.equal(await killed, true);
    assert.equal(tool.isAlive(), false);
    assert.equal(tool.process, null);
  });

  test('kill resolves false before spawning and after exit', async () => {
    const tool = new FakeTool({});
    assert.equal(await tool.kill(), false);

    const exited = new FakeTool({});
    exited.spawnProcess(EXIT_NOW);
    await once(exited.process, 'close');
    assert.equal(await exited.kill(), false);
  });

  test('close marks the instance exited and notifies onExit; pid survives', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess(EXIT_NOW);
    const proc = tool.process;
    await once(proc, 'close');

    assert.equal(tool.process, null);
    assert.equal(tool.isAlive(), false);
    assert.equal(tool.lastExit.code, 0);
    assert.equal(tool.lastExit.cmd, process.execPath);
    assert.equal(tool.pid, proc.pid);
  });

  test('spawn errors fold into the exit payload', async () => {
    const tool = new FakeTool({ cmd: 'definitely-no-such-binary' });
    tool.spawnProcess(EXIT_NOW);
    const closed = new Promise((resolve) => tool.process.on('close', resolve));
    await closed; // events.once() would reject on the expected 'error' event

    assert.match(tool.lastExit.errors, /ENOENT/);
    assert.equal(tool.lastExit.code, -2);
  });

  test('an externally killed process reports the signal', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess(['-e', 'process.kill(process.pid, "SIGKILL")']);
    await once(tool.process, 'close');

    assert.equal(tool.lastExit.signal, 'SIGKILL');
    assert.equal(tool.lastExit.code, null);
  });

  test('stderr survives exit and flows into the exit payload', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess(['-e', 'console.error("kaput")'], ['ignore', 'ignore', 'pipe']);
    await once(tool.process, 'close');

    assert.ok(tool.lastExit.errors.includes('kaput'));
  });

  test('an owner kill does not notify onExit', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess();

    await tool.kill();
    assert.equal(tool.lastExit, null);
  });

  test('SIGKILL fallback fires when the process ignores SIGTERM', async () => {
    const tool = new FakeTool({ sigkillDelayMs: 50 });
    tool.spawnProcess(IGNORE_SIGTERM);
    const proc = tool.process;
    // Wait until the child has booted and registered its SIGTERM handler —
    // otherwise the default (terminate) would fire instead of the fallback.
    await once(proc.stdout, 'data');

    const killed = tool.kill();
    assert.equal(await killed, true);
    assert.equal(proc.signalCode, 'SIGKILL');
  });

  test('pipe feeds one running instance stdout into another stdin', async () => {
    const source = new FakeTool({});
    const sink = new FakeTool({});
    source.spawnProcess(['-e', "process.stdout.write('ping')"], ['ignore', 'pipe', 'ignore']);
    sink.spawnProcess(
      ['-e', "process.stdin.on('data', (data) => process.stdout.write(data))"],
      ['pipe', 'pipe', 'ignore']
    );

    source.pipe(sink);
    const [echoed] = await once(sink.process.stdout, 'data');

    assert.equal(echoed.toString(), 'ping');
    await Promise.all([source.kill(), sink.kill()]); // cleanup
  });
});

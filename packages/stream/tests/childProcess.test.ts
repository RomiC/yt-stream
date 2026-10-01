import { beforeAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import type { StdioOptions } from 'node:child_process';
import type { ChildProcess, ProcessExit } from '../src/childProcess';

const KEEP_ALIVE = ['-e', 'setInterval(() => {}, 1000)'];
const IGNORE_SIGTERM = [
  '-e',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')"
];
const EXIT_NOW = ['-e', ''];

interface Tool extends ChildProcess {
  lastExit: ProcessExit | null;
  spawnProcess(args?: string[], stdio?: StdioOptions): ChildProcess;
}

let FakeTool: new (options: { cmd?: string; sigkillDelayMs?: number }) => Tool;

beforeAll(async () => {
  const { ChildProcess } = await import('../src/childProcess');

  FakeTool = class extends ChildProcess implements Tool {
    lastExit: ProcessExit | null = null;

    constructor(options: { cmd?: string; sigkillDelayMs?: number }) {
      super({ cmd: process.execPath, ...options });
      this.onExit((exit) => {
        this.lastExit = exit;
      });
    }

    spawnProcess(args = KEEP_ALIVE, stdio: StdioOptions = ['ignore', 'pipe', 'ignore']): ChildProcess {
      return this.spawn(args, stdio);
    }
  };
});

describe('ChildProcess', () => {
  test('spawn tracks the running process and returns the instance for chaining', async () => {
    const tool = new FakeTool({});

    const returned = tool.spawnProcess();

    expect(returned).toBe(tool);
    expect(tool.isAlive()).toBe(true);
    expect(tool.process?.pid ?? 0).toBeGreaterThan(0);
    await tool.kill();
  });

  test('onExit and spawn chain from the instance', async () => {
    const tool = new FakeTool({});

    const chained = tool.onExit(() => {}).spawnProcess();

    expect(chained).toBe(tool);
    expect(tool.isAlive()).toBe(true);
    await tool.kill();
  });

  test('a second spawn throws — a new process is a new instance', async () => {
    const tool = new FakeTool({});
    try {
      tool.spawnProcess();
      expect(() => tool.spawnProcess()).toThrow(/already spawned/);
    } finally {
      await tool.kill();
    }
  });

  test('kill resolves true once the process has fully exited', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess();
    const proc = tool.process!;

    const killed = tool.kill();
    expect(proc.killed).toBe(true);
    expect(await killed).toBe(true);
    expect(tool.isAlive()).toBe(false);
    expect(tool.process).toBeNull();
  });

  test('kill resolves false before spawning and after exit', async () => {
    const tool = new FakeTool({});
    expect(await tool.kill()).toBe(false);

    const exited = new FakeTool({});
    exited.spawnProcess(EXIT_NOW);
    await once(exited.process!, 'close');
    expect(await exited.kill()).toBe(false);
  });

  test('close marks the instance exited and notifies onExit; pid survives', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess(EXIT_NOW);
    const proc = tool.process!;
    await once(proc, 'close');

    expect(tool.process).toBeNull();
    expect(tool.isAlive()).toBe(false);
    expect(tool.lastExit?.code).toBe(0);
    expect(tool.lastExit?.cmd).toBe(process.execPath);
    expect(tool.pid).toBe(proc.pid ?? null);
  });

  test('spawn errors fold into the exit payload', async () => {
    const tool = new FakeTool({ cmd: 'definitely-no-such-binary' });
    tool.spawnProcess(EXIT_NOW);
    const closed = new Promise((resolve) => tool.process!.on('close', resolve));
    await closed; // events.once() would reject on the expected 'error' event

    expect(tool.lastExit?.errors.length ?? 0).toBeGreaterThan(0);
    expect(tool.lastExit?.code).toBe(-2);
  });

  test('an externally killed process reports the signal', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess(['-e', 'process.kill(process.pid, "SIGKILL")']);
    await once(tool.process!, 'close');

    expect(tool.lastExit?.signal).toBe('SIGKILL');
    expect(tool.lastExit?.code).toBeNull();
  });

  test('stderr survives exit and flows into the exit payload', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess(['-e', 'console.error("kaput")'], ['ignore', 'ignore', 'pipe']);
    await once(tool.process!, 'close');

    expect(tool.lastExit?.errors.includes('kaput')).toBe(true);
  });

  test('an owner kill does not notify onExit', async () => {
    const tool = new FakeTool({});
    tool.spawnProcess();

    await tool.kill();
    expect(tool.lastExit).toBeNull();
  });

  test('SIGKILL fallback fires when the process ignores SIGTERM', async () => {
    const tool = new FakeTool({ sigkillDelayMs: 50 });
    tool.spawnProcess(IGNORE_SIGTERM);
    const proc = tool.process!;
    await once(proc.stdout!, 'data');

    const killed = tool.kill();
    expect(await killed).toBe(true);
    expect(proc.signalCode).toBe('SIGKILL');
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
    const [echoed] = await once(sink.process!.stdout!, 'data');

    expect(echoed.toString()).toBe('ping');
    await Promise.all([source.kill(), sink.kill()]);
  });
});

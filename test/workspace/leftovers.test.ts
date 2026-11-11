import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  elapsedMs,
  ProcessLog,
  type RunningCommand,
  startTimes,
  stopLeftovers,
} from '../../src/workspace/leftovers.js';
import { LocalWorkspace } from '../../src/workspace/local.js';
import { tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** A process that runs until stopped, in its own group on POSIX like heaw's commands. */
function longRunning(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  children.push(child);
  return child;
}

/** The id of a process that has ended: an owner that is gone. */
async function endedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid!;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

/** Notes `commands` as another heaw's, `owner` being its process id. */
function noteAsOther(dir: string, owner: number, commands: RunningCommand[]): string {
  const file = join(dir, `${owner}-test.json`);
  writeFileSync(file, JSON.stringify({ owner: { pid: owner }, commands }));
  return file;
}

describe('commands left running by a heaw that ended', () => {
  it('reads how long a process has run, as ps prints it', () => {
    expect(elapsedMs('05:12')).toBe(312_000);
    expect(elapsedMs('01:02:03')).toBe(3_723_000);
    expect(elapsedMs('2-01:02:03')).toBe(2 * 86_400_000 + 3_723_000);
    expect(elapsedMs('later')).toBeNaN();
  });

  it('finds when a running process started', { timeout: 30_000 }, async () => {
    const started = await startTimes([process.pid]);
    const expected = Date.now() - process.uptime() * 1000;
    expect(Math.abs((started?.get(process.pid) ?? 0) - expected)).toBeLessThan(5_000);
  });

  it('notes running commands while they run, in a file of their own', async () => {
    const dir = await tempDir();
    const log = new ProcessLog(dir);
    const command = { pid: 4242, startedAt: 1, execId: 'x', command: 'npm run dev', cwd: dir };

    log.add(command);
    const [file] = readdirSync(dir);
    expect(file).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{8}\\.json$`));
    expect(JSON.parse(readFileSync(join(dir, file!), 'utf8'))).toEqual({
      owner: { pid: process.pid },
      commands: [command],
    });

    log.remove(4242);
    expect(readdirSync(dir)).toEqual([]);
    // A heaw that is running keeps its commands: its own files are never leftovers.
    log.add(command);
    expect(await stopLeftovers(dir)).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
    log.close();
    expect(readdirSync(dir)).toEqual([]);
  });

  it(
    'stops a command whose heaw ended without stopping it, and says so',
    { timeout: 30_000 },
    async () => {
      const dir = await tempDir();
      const root = await tempDir();
      const workspace = new LocalWorkspace(root, { processLog: new ProcessLog(dir) });
      const server = workspace.exec(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, {
        timeoutMs: 60_000,
      });
      expect(await until(() => readdirSync(dir).length === 1)).toBe(true);
      const ours = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8')) as {
        commands: RunningCommand[];
      };
      // As if a heaw that is gone had started it.
      noteAsOther(dir, await endedPid(), ours.commands);

      const notices = await stopLeftovers(dir);

      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(
        /^heaw stopped a command that an earlier heaw left running when it ended without stopping it: ".*setInterval.*" \(in .*, since \d\d:\d\d\)\.$/,
      );
      const result = await server;
      expect(result.exitCode).not.toBe(0);
      await workspace.dispose();
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it(
    'leaves a process alone that got the id of a noted command later',
    { timeout: 30_000 },
    async () => {
      const dir = await tempDir();
      const other = longRunning();
      const file = noteAsOther(dir, await endedPid(), [
        // The id is that of a running process, but it started an hour after the noted command.
        {
          pid: other.pid!,
          startedAt: Date.now() - 3_600_000,
          execId: 'x',
          command: 'npm run dev',
          cwd: dir,
        },
      ]);

      expect(await stopLeftovers(dir)).toEqual([]);
      expect(isRunning(other.pid!)).toBe(true);
      expect(readdirSync(dir)).not.toContain(file);
    },
  );

  it(
    'stops a noted process by its id when its start time matches',
    { timeout: 30_000 },
    async () => {
      const dir = await tempDir();
      const left = longRunning();
      const startedAt = Date.now();
      noteAsOther(dir, await endedPid(), [
        // No Git Bash to find it by its marker: the id and start time have to do.
        { pid: left.pid!, startedAt, execId: 'x', command: 'npm run dev', cwd: dir },
      ]);

      const notices = await stopLeftovers(dir);

      expect(notices).toEqual([expect.stringContaining('"npm run dev" (in ')]);
      expect(await until(() => !isRunning(left.pid!))).toBe(true);
    },
  );

  it('leaves the commands of a heaw that is still running alone', async () => {
    const dir = await tempDir();
    const owner = longRunning();
    const command = longRunning();
    noteAsOther(dir, owner.pid!, [
      { pid: command.pid!, startedAt: Date.now(), execId: 'x', command: 'npm run dev', cwd: dir },
    ]);

    expect(await stopLeftovers(dir)).toEqual([]);
    expect(isRunning(command.pid!)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

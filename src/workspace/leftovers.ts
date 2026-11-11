import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killGroup, killMarked, killWindowsTree } from './process.js';

/** Where heaw notes the commands it runs: `<heaw home>/processes/`. */
export const PROCESSES_DIR = 'processes';

/** A start time this close to the noted one is the same process; a later one got its id since. */
const SAME_START_MS = 5_000;
/** Longest the query for process start times may take. */
const QUERY_TIMEOUT_MS = 15_000;

export interface RunningCommand {
  /** The shell's process id; on POSIX also its process group (it is spawned detached). */
  pid: number;
  /** When it was spawned (ms since the epoch): with `pid`, tells it from a later process that got the id. */
  startedAt: number;
  /** The `HEAW_EXEC_ID` every process of the command carries. */
  execId: string;
  command: string;
  cwd: string;
  /** Windows: the Git Bash it ran in, whose process table finds its processes by `execId`. */
  msysBash?: string;
}

interface ProcessFile {
  owner: { pid: number };
  commands: RunningCommand[];
}

/** The files this heaw process writes itself: never leftovers, though their owner's id is ours. */
const ownFiles = new Set<string>();

/**
 * The commands a workspace is running, in a file of its own, so that the next heaw can stop them
 * when this one ended without doing so (the terminal closed or the process was killed). A dev
 * server left that way kept its port and stopped answering, and every later start failed on it.
 * The file exists only while commands run. Noting is best effort: a command never fails on it.
 */
export class ProcessLog {
  readonly #dir: string;
  readonly #file: string;
  readonly #commands = new Map<number, RunningCommand>();

  constructor(dir: string) {
    this.#dir = dir;
    this.#file = join(dir, `${process.pid}-${randomUUID().slice(0, 8)}.json`);
    ownFiles.add(this.#file);
  }

  add(command: RunningCommand): void {
    this.#commands.set(command.pid, command);
    this.#write();
  }

  remove(pid: number): void {
    if (this.#commands.delete(pid)) this.#write();
  }

  /** Once the workspace stopped its commands. */
  close(): void {
    this.#commands.clear();
    this.#write();
  }

  #write(): void {
    try {
      if (!this.#commands.size) {
        rmSync(this.#file, { force: true });
        return;
      }
      mkdirSync(this.#dir, { recursive: true });
      const record: ProcessFile = {
        owner: { pid: process.pid },
        commands: [...this.#commands.values()],
      };
      writeFileSync(this.#file, JSON.stringify(record));
    } catch {
      // Without the note, a command left behind is only not stopped later.
    }
  }
}

/**
 * Stops the commands an earlier heaw left running when it ended without stopping them, and
 * returns what to tell the user. A command is stopped only when it is certainly the one heaw
 * started: by the marker its processes carry (Git Bash on Windows), or by its process id with a
 * matching start time, so a process that got the id later is never touched. Files of a heaw
 * that is still running are left alone.
 */
export async function stopLeftovers(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const leftovers: RunningCommand[] = [];
  const done: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    if (ownFiles.has(file)) continue;
    const ownerPid = Number(name.split('-')[0]);
    // Its owner's id is ours only when that heaw ended and this one got the id.
    if (ownerPid !== process.pid && isRunning(ownerPid)) continue;
    try {
      leftovers.push(...(JSON.parse(readFileSync(file, 'utf8')) as ProcessFile).commands);
    } catch {
      // Cut off while it was written: nothing usable in it.
    }
    done.push(file);
  }
  const notices: string[] = [];
  if (leftovers.length) {
    const stopped: RunningCommand[] = [];
    const unsure: RunningCommand[] = [];
    let remaining = leftovers;
    if (process.platform === 'win32') {
      remaining = [];
      for (const command of leftovers) {
        const bash = command.msysBash;
        const found = bash && existsSync(bash) ? await killMarked(bash, command.execId) : 0;
        if (found) stopped.push(command);
        else remaining.push(command);
      }
    }
    const started = remaining.length
      ? await startTimes(remaining.map((command) => command.pid))
      : new Map<number, number>();
    for (const command of remaining) {
      if (!started) {
        if (isRunning(command.pid)) unsure.push(command);
        continue;
      }
      const at = started.get(command.pid);
      if (at === undefined || Math.abs(at - command.startedAt) > SAME_START_MS) continue;
      await (process.platform === 'win32' ? killWindowsTree(command.pid) : killGroup(command.pid));
      stopped.push(command);
    }
    if (stopped.length) notices.push(stoppedNotice(stopped));
    for (const command of unsure) notices.push(unsureNotice(command));
  }
  for (const file of done) rmSync(file, { force: true });
  return notices;
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When the processes still running among `pids` were started (ms since the epoch), or
 * undefined when that cannot be found out.
 */
export function startTimes(pids: number[]): Promise<Map<number, number> | undefined> {
  const now = Date.now();
  const query =
    process.platform === 'win32'
      ? {
          file: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process -Filter '${pids.map((pid) => `ProcessId=${pid}`).join(' OR ')}' | ` +
              "ForEach-Object { '{0} {1}' -f $_.ProcessId, [int64]((Get-Date) - $_.CreationDate).TotalMilliseconds }",
          ],
          // How long each has run, in milliseconds.
          toMs: (age: string) => Number(age),
        }
      : // How long each has run, as [[dd-]hh:]mm:ss.
        { file: 'ps', args: ['-o', 'pid=,etime=', '-p', pids.join(',')], toMs: elapsedMs };
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(query.file, query.args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' },
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, QUERY_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (text: string) => (output += text));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    // `ps` exits with 1 when none of them runs any more: an answer too.
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1) return resolve(undefined);
      const found = new Map<number, number>();
      for (const line of output.split('\n')) {
        const [pid, age] = line.trim().split(/\s+/);
        const ms = age === undefined ? NaN : query.toMs(age);
        if (pid && Number.isFinite(ms)) found.set(Number(pid), now - ms);
      }
      resolve(found);
    });
  });
}

/** `ps -o etime` as milliseconds: `mm:ss`, `hh:mm:ss` or `dd-hh:mm:ss`. */
export function elapsedMs(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match) return NaN;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return (
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
  );
}

function stoppedNotice(commands: RunningCommand[]): string {
  const list = commands
    .map((command) => `"${command.command}" (in ${command.cwd}, since ${clock(command.startedAt)})`)
    .join(', ');
  const which = commands.length === 1 ? 'a command' : `${commands.length} commands`;
  return `heaw stopped ${which} that an earlier heaw left running when it ended without stopping it: ${list}.`;
}

function unsureNotice(command: RunningCommand): string {
  const stop =
    process.platform === 'win32' ? `taskkill /PID ${command.pid} /T /F` : `kill -- -${command.pid}`;
  return (
    `An earlier heaw that ended without stopping its commands may have left "${command.command}" ` +
    `running (process ${command.pid}, in ${command.cwd}), and heaw could not check that this ` +
    `process is still that command. If it is, stop it with: ${stop}`
  );
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

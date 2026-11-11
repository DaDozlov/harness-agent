import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Stops a command and everything it started. Killing only the shell would leave its children
 * (`npm test`, a dev server, …) running. On POSIX the command runs in its own process group
 * (spawned with `detached: true`); on Windows `taskkill /T` walks the process tree. Resolves
 * once taskkill is done: heaw must wait for it before exiting, as Windows ends an unfinished
 * taskkill together with heaw, and the tree would live on.
 */
export function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('error', () => {
          child.kill();
          resolve();
        })
        .on('close', () => resolve());
    });
  }

  return killGroup(pid, (signal) => child.kill(signal));
}

/**
 * POSIX: stops a process group (a command spawned with `detached: true`, led by its shell),
 * SIGTERM first and SIGKILL when it does not end. `fallback` signals the shell alone when the
 * group cannot be signalled.
 */
export async function killGroup(
  pid: number,
  fallback: (signal: NodeJS.Signals) => void = () => {},
): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      fallback(signal);
    }
  };
  // Waits for the whole group, not the shell: the shell ends at once on SIGTERM while what it
  // started is still shutting down, or ignores SIGTERM. A SIGKILL left to a timer would never
  // be sent if heaw exited first, and was skipped once the shell had ended.
  signalGroup('SIGTERM');
  if (await groupGone(pid, STOP_GRACE_MS)) return;
  signalGroup('SIGKILL');
  await groupGone(pid, KILL_WAIT_MS);
}

/** Windows: stops a process and everything it started, by id. */
export function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => resolve())
      .on('close', () => resolve());
  });
}

/** How long a stopped command may take to end on SIGTERM before its group is killed. */
const STOP_GRACE_MS = 2_000;
/** How long to wait for a killed group to be gone. */
const KILL_WAIT_MS = 1_000;

/** Whether no process of the group is left, checked until `ms` have passed. */
async function groupGone(group: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(-group, 0);
    } catch (error) {
      // ESRCH: none left. EPERM: one is left that we may not signal.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() >= until) return false;
    await sleep(25);
  }
}

/** Longest a sweep for leftover processes may take, so stopping never hangs on it. */
const SWEEP_TIMEOUT_MS = 10_000;

/**
 * Git Bash on Windows: `exec` in a script (the Maven wrapper, `mvn`, many npm bins) starts a new
 * Windows process and ends the old one, which breaks the parent chain `taskkill /T` follows; a
 * dev server started that way would outlive a stop, holding the output pipe open. Git Bash keeps
 * its own process table, where exec keeps the process and its environment: every process still
 * carrying the command's `HEAW_EXEC_ID` is found in `/proc` and stopped with its Windows subtree.
 * Resolves with how many such processes it found.
 */
export function killMarked(bash: string, execId: string): Promise<number> {
  const script =
    'for p in /proc/[0-9]*; do ' +
    `grep -qa "HEAW_EXEC_ID=${execId}" "$p/environ" 2>/dev/null && cat "$p/winpid"; done`;
  return new Promise((resolve) => {
    let pids: string[] = [];
    const done = () => {
      clearTimeout(timer);
      resolve(pids.length);
    };
    const timer = setTimeout(done, SWEEP_TIMEOUT_MS);
    let found = '';
    // The sweep itself must not carry the marker, or it would find and stop itself.
    const sweep = spawn(bash, ['-c', script], {
      env: { ...process.env, HEAW_EXEC_ID: '' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    sweep.stdout.setEncoding('utf8').on('data', (text: string) => (found += text));
    sweep.on('error', done);
    sweep.on('close', () => {
      pids = found.split(/\s+/).filter((pid) => /^\d+$/.test(pid));
      if (!pids.length) return done();
      spawn('taskkill', [...pids.flatMap((pid) => ['/pid', pid]), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
        .on('error', done)
        .on('close', done);
    });
  });
}

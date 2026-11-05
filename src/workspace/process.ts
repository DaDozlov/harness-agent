import { type ChildProcess, spawn } from 'node:child_process';

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

  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL');
  }, 2_000).unref();
  return Promise.resolve();
}

/** Longest a sweep for leftover processes may take, so stopping never hangs on it. */
const SWEEP_TIMEOUT_MS = 10_000;

/**
 * Git Bash on Windows: `exec` in a script (the Maven wrapper, `mvn`, many npm bins) starts a new
 * Windows process and ends the old one, which breaks the parent chain `taskkill /T` follows; a
 * dev server started that way would outlive a stop, holding the output pipe open. Git Bash keeps
 * its own process table, where exec keeps the process and its environment: every process still
 * carrying the command's `HEAW_EXEC_ID` is found in `/proc` and stopped with its Windows subtree.
 */
export function killMarked(bash: string, execId: string): Promise<void> {
  const script =
    'for p in /proc/[0-9]*; do ' +
    `grep -qa "HEAW_EXEC_ID=${execId}" "$p/environ" 2>/dev/null && cat "$p/winpid"; done`;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
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
      const pids = found.split(/\s+/).filter((pid) => /^\d+$/.test(pid));
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

import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Stops a command and everything it started. Killing only the shell would leave its children
 * (`npm test`, a dev server, …) running. On POSIX the command runs in its own process group
 * (spawned with `detached: true`); on Windows `taskkill /T` walks the process tree.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => child.kill(),
    );
    return;
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
}

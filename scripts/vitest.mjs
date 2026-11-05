// Runs Vitest with `npm test`. On Windows, a working directory with a lowercase drive letter
// (c:\…, as VS Code's terminal sometimes opens it) makes Vitest load itself twice, and every test
// file fails with "Vitest failed to find the current suite". Starting it from C:\… avoids that.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const upperDrive = (path) =>
  process.platform === 'win32' && /^[a-z]:/.test(path)
    ? path.charAt(0).toUpperCase() + path.slice(1)
    : path;

const vitest = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const { status, error } = spawnSync(
  process.execPath,
  [upperDrive(vitest), ...process.argv.slice(2)],
  { cwd: upperDrive(process.cwd()), stdio: 'inherit' },
);
if (error) throw error;
process.exit(status ?? 1);

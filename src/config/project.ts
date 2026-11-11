import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILES = [
  'heaw.config.ts',
  'heaw.config.mts',
  'heaw.config.js',
  'heaw.config.mjs',
];

/** Where personal settings live: `HEAW_HOME`, or `~/.heaw`. */
export function heawHome(env: Record<string, string | undefined> = process.env): string {
  return env.HEAW_HOME ?? join(homedir(), '.heaw');
}

/**
 * The project a directory belongs to, found like git finds a repository: the nearest directory
 * upwards with a heaw config file or a `.heaw/` folder, else the nearest git repository root,
 * else the directory itself. The home directory's `.heaw/` holds personal settings, so it never
 * makes home a project: the real home's neither, when a test passes another `userHome`.
 */
export function findProjectRoot(cwd: string, userHome: string = homedir()): string {
  const homes = new Set([realPath(userHome), realPath(homedir())]);
  let gitRoot: string | undefined;
  for (let dir = resolve(cwd); ;) {
    if (!homes.has(realPath(dir))) {
      if (CONFIG_FILES.some((file) => existsSync(join(dir, file)))) return dir;
      if (existsSync(join(dir, '.heaw'))) return dir;
    }
    if (!gitRoot && existsSync(join(dir, '.git'))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ?? resolve(cwd);
}

/** The first existing file of `names` in `dir`. */
export function findFile(dir: string, names: readonly string[]): string | undefined {
  return names.map((name) => join(dir, name)).find((path) => existsSync(path));
}

/**
 * A path to compare. On Windows a path can name home by its short 8.3 name (`C:\Users\DANIIL~1`,
 * as `TEMP` often does), which only the native realpath expands.
 */
function realPath(path: string): string {
  let real = resolve(path);
  try {
    real = realpathSync.native(real);
  } catch {
    // Not there (yet): compared as written.
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

import { existsSync } from 'node:fs';
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
 * makes home a project.
 */
export function findProjectRoot(cwd: string, userHome: string = homedir()): string {
  let gitRoot: string | undefined;
  for (let dir = resolve(cwd); ;) {
    if (!samePath(dir, userHome)) {
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

function samePath(a: string, b: string): boolean {
  const normalize = (path: string) => {
    const resolved = resolve(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

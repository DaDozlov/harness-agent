import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG_FILES } from './project.js';

/** Folders the user trusted to run their setup: `<heaw home>/trusted-projects.json`. */
export const TRUSTED_PROJECTS_FILE = 'trusted-projects.json';

/**
 * The files of a project that run code when heaw loads it (docs/DESIGN.md §8): `heaw.config.*`
 * is executed, and `.mcp.json` names programs heaw starts. Empty when there are none, and then
 * there is nothing to trust.
 */
export function codeRunningFiles(projectRoot: string): string[] {
  return [...CONFIG_FILES, '.mcp.json'].filter((file) => existsSync(join(projectRoot, file)));
}

/** Whether the user trusted this folder (`trustProject`). */
export function isTrusted(heawHome: string, projectRoot: string): boolean {
  return read(heawHome).includes(key(projectRoot));
}

/** Remembers that the user trusts this folder, e.g. after the chat asked, or `heaw init`. */
export function trustProject(heawHome: string, projectRoot: string): void {
  const trusted = read(heawHome);
  if (trusted.includes(key(projectRoot))) return;
  const file = join(heawHome, TRUSTED_PROJECTS_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify([...trusted, key(projectRoot)], null, 2)}\n`);
}

/** The question the chat asks before it loads an untrusted project's setup. */
export function trustQuestion(projectRoot: string, files: string[]): string {
  return (
    `${projectRoot} has ${files.join(' and ')}. Loading ${files.length === 1 ? 'it' : 'them'} ` +
    'runs code on this machine: heaw.config.* is executed, and .mcp.json starts the programs it ' +
    'names. Go on only in a project you trust, your own or one you have read.\n' +
    'Trust this folder? [y/N] '
  );
}

function read(heawHome: string): string[] {
  try {
    const data: unknown = JSON.parse(readFileSync(join(heawHome, TRUSTED_PROJECTS_FILE), 'utf8'));
    return Array.isArray(data)
      ? data.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The folder as one spelling: real path (short Windows names expanded), case-blind on Windows. */
function key(projectRoot: string): string {
  let path = resolve(projectRoot);
  try {
    path = realpathSync.native(path);
  } catch {
    // Not there: as written.
  }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

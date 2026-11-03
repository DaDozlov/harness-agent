import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import {
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type RipgrepResult,
  type Workspace,
  WorkspaceError,
} from '../core/workspace.js';
import {
  capture,
  COMMAND_ENV,
  DEFAULT_TIMEOUT_MS,
  MAX_CAPTURE_CHARS,
  OutputBuffer,
} from './exec.js';
import { killTree } from './process.js';
import { detectShell, type ShellSpec } from './shell.js';

/** Runs tools directly on this machine, confined to `root` (docs/DESIGN.md §4.12). */
export class LocalWorkspace implements Workspace {
  readonly kind: string = 'local';
  readonly root: string;
  readonly shell: string;
  readonly #shell: ShellSpec;
  readonly #running = new Set<ChildProcess>();

  constructor(root: string, options: { shell?: ShellSpec } = {}) {
    this.root = resolve(root);
    this.#shell = options.shell ?? detectShell();
    this.shell = this.#shell.name;
  }

  resolve(path: string): string {
    const absolute = resolve(this.root, path);
    if (this.#isOutside(absolute)) {
      throw new WorkspaceError(`"${path}" is outside the workspace (${this.root}).`);
    }
    return absolute;
  }

  displayPath(path: string): string {
    const absolute = resolve(this.root, path);
    const shown = this.#isOutside(absolute) ? absolute : relative(this.root, absolute) || '.';
    return shown.split(sep).join('/');
  }

  readFile(path: string): Promise<Buffer> {
    return readFile(this.resolve(path));
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const absolute = this.resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, data);
  }

  async removeFile(path: string): Promise<void> {
    await rm(this.resolve(path), { force: true });
  }

  async stat(path: string): Promise<FileStat | undefined> {
    try {
      const info = await stat(this.resolve(path));
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(path: string): Promise<DirEntry[]> {
    const entries = await readdir(this.resolve(path), { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const child = spawn(this.#shell.file, this.#shell.args(command), {
      cwd: this.resolve(options.cwd ?? '.'),
      env: { ...process.env, ...COMMAND_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX, so the whole tree can be stopped (see killTree).
      detached: process.platform !== 'win32',
    });
    this.#running.add(child);
    try {
      return await capture(child, {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
        stop: () => killTree(child),
        startError: (error) => `Could not start ${this.#shell.file}: ${error.message}`,
      });
    } finally {
      this.#running.delete(child);
    }
  }

  ripgrep(
    args: string[],
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<RipgrepResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(rgPath, args, {
        cwd: this.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(options.signal && { signal: options.signal }),
      });
      const stdout = new OutputBuffer(MAX_CAPTURE_CHARS);
      const stderr = new OutputBuffer(MAX_CAPTURE_CHARS);
      child.stdout.setEncoding('utf8').on('data', (text: string) => stdout.append(text));
      child.stderr.setEncoding('utf8').on('data', (text: string) => stderr.append(text));
      child.on('error', reject);
      child.on('close', (code) =>
        resolveResult({ exitCode: code ?? 2, stdout: stdout.text, stderr: stderr.text }),
      );
    });
  }

  dispose(): Promise<void> {
    for (const child of this.#running) killTree(child);
    this.#running.clear();
    return Promise.resolve();
  }

  #isOutside(absolute: string): boolean {
    const path = relative(this.root, absolute);
    return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
  }
}

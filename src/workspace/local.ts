import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import { isSecretName } from '../core/redact.js';
import { killMarked, killTree } from './process.js';
import { detectShell, type ShellSpec } from './shell.js';

export interface LocalWorkspaceOptions {
  shell?: ShellSpec;
  /** Variables commands do not get. Default: those whose name looks like a secret. */
  hideEnv?: (name: string) => boolean;
}

/** Runs tools directly on this machine, confined to `root` (docs/DESIGN.md §4.12). */
export class LocalWorkspace implements Workspace {
  readonly kind: string = 'local';
  readonly root: string;
  readonly shell: string;
  readonly #shell: ShellSpec;
  /** Running commands, with the marker their processes carry (see `#stop`). */
  readonly #running = new Map<ChildProcess, string>();
  /** Stops still going (taskkill, sweeps), which `dispose` waits for. */
  readonly #stopping = new Set<Promise<void>>();

  /** Variables kept from commands: heaw's credentials and anything that looks like a secret. */
  readonly #hidden: (name: string) => boolean;

  constructor(root: string, options: LocalWorkspaceOptions = {}) {
    this.root = resolve(root);
    this.#shell = options.shell ?? detectShell();
    this.shell = this.#shell.name;
    this.#hidden = options.hideEnv ?? isSecretName;
  }

  /**
   * The environment commands run with: this process's, without its secrets. A command the agent
   * runs (or a test it wrote) would otherwise see the model's API key and could send it out.
   */
  #commandEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!this.#hidden(name)) env[name] = value;
    }
    return env;
  }

  resolve(path: string): string {
    const absolute = resolve(this.root, path);
    if (this.#isOutside(absolute)) {
      throw new WorkspaceError(`"${path}" is outside the workspace (${this.root}).`);
    }
    // A link inside the workspace can lead out of it: what counts is where it really goes.
    const real = this.#real(absolute);
    if (outside(this.#realRoot(), real)) {
      throw new WorkspaceError(
        `"${path}" leads outside the workspace through a link (to ${real}).`,
      );
    }
    return absolute;
  }

  /**
   * Relative to the root, with forward slashes: where the path really leads, so that rules see
   * `.git/hooks/pre-commit` for a write through a link to `.git`.
   */
  displayPath(path: string): string {
    const absolute = resolve(this.root, path);
    if (this.#isOutside(absolute)) return absolute.split(sep).join('/');
    const real = this.#real(absolute);
    const root = this.#realRoot();
    const shown = outside(root, real)
      ? relative(this.root, absolute) || '.'
      : relative(root, real) || '.';
    return shown.split(sep).join('/');
  }

  #rootReal: string | undefined;

  #realRoot(): string {
    if (this.#rootReal === undefined) this.#rootReal = realOrSelf(this.root);
    return this.#rootReal;
  }

  /** `absolute` with its links followed, as far as it exists (a new file's folder, say). */
  #real(absolute: string): string {
    const missing: string[] = [];
    let current = absolute;
    for (;;) {
      try {
        return join(realpathSync.native(current), ...missing.reverse());
      } catch {
        const parent = dirname(current);
        if (parent === current) return absolute;
        missing.push(basename(current));
        current = parent;
      }
    }
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
    // Marks every process of this command, so stopping it can find them all (see #stop).
    const execId = randomUUID();
    const child = spawn(this.#shell.file, this.#shell.args(command), {
      cwd: this.resolve(options.cwd ?? '.'),
      env: { ...this.#commandEnv(), ...COMMAND_ENV, HEAW_EXEC_ID: execId },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX, so the whole tree can be stopped (see killTree).
      detached: process.platform !== 'win32',
    });
    this.#running.set(child, execId);
    try {
      return await capture(child, {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
        onOutput: options.onOutput,
        stop: () => this.#stop(child, execId),
        startError: (error) => `Could not start ${this.#shell.file}: ${error.message}`,
      });
    } finally {
      this.#running.delete(child);
    }
  }

  /** Stops a command and everything it started, in Git Bash also what `exec` cut loose. */
  #stop(child: ChildProcess, execId: string): void {
    const sweep = this.#shell.msys && process.platform === 'win32';
    const stopping = Promise.all([
      killTree(child),
      sweep ? killMarked(this.#shell.file, execId) : undefined,
    ]).then(() => undefined);
    this.#stopping.add(stopping);
    void stopping.finally(() => this.#stopping.delete(stopping));
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

  async dispose(): Promise<void> {
    for (const [child, execId] of this.#running) this.#stop(child, execId);
    this.#running.clear();
    await Promise.all(this.#stopping);
  }

  #isOutside(absolute: string): boolean {
    return outside(this.root, absolute);
  }
}

function outside(root: string, absolute: string): boolean {
  const path = relative(root, absolute);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

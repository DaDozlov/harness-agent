/**
 * Where tools act: files and command execution (docs/DESIGN.md §4.12). Tools only touch the
 * outside world through a workspace, so the same tools run locally or inside a container.
 *
 * Paths may be relative to `root` or absolute; every method resolves them with `resolve`, which
 * rejects paths outside the workspace.
 */
export interface Workspace {
  /** `local`, `docker`, … */
  readonly kind: string;
  /** Absolute path of the workspace root. */
  readonly root: string;
  /** The shell `exec` uses, as described to the model, e.g. `bash (Git Bash)`. */
  readonly shell: string;
  /** What else the model should know about where commands run, e.g. "inside a container". */
  readonly description?: string | undefined;

  /** Gets ready ahead of the first command, e.g. starts a container. Errors show up in `exec`. */
  prepare?(): Promise<void>;

  /** Absolute path for `path`. Throws `WorkspaceError` when it is outside the workspace. */
  resolve(path: string): string;
  /** Path relative to the root with forward slashes, for display and permission rules. */
  displayPath(path: string): string;

  readFile(path: string): Promise<Buffer>;
  /** Creates missing parent directories. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Removes a file; nothing happens when it does not exist. Used to rewind the agent's changes. */
  removeFile(path: string): Promise<void>;
  /** `undefined` when nothing exists at `path`. */
  stat(path: string): Promise<FileStat | undefined>;
  list(path: string): Promise<DirEntry[]>;

  /** Runs a shell command. Never throws for a failing command; check `exitCode`. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Runs ripgrep with these arguments in the workspace root. Used for file search. */
  ripgrep(args: string[], options?: { signal?: AbortSignal | undefined }): Promise<RipgrepResult>;

  /** Stops anything still running. */
  dispose(): Promise<void>;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface ExecOptions {
  /** Working directory, relative to the root. Default: the root. */
  cwd?: string | undefined;
  /** Stop the command after this long. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Gets the output as it comes, e.g. of a command running in the background. */
  onOutput?: ((text: string) => void) | undefined;
}

export interface ExecResult {
  /** `null` when the command was stopped (timeout or abort). */
  exitCode: number | null;
  /** stdout and stderr interleaved, as a terminal would show them. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RipgrepResult {
  /** 0: matches found, 1: no matches, 2: error. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A workspace refused an operation, e.g. a path outside the root. The message is for the model. */
export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
}

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CONFIG_FILES } from '../config/project.js';
import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  FileStat,
  RipgrepResult,
  Workspace,
} from '../core/workspace.js';
import { capture, COMMAND_ENV, DEFAULT_TIMEOUT_MS, OutputBuffer } from './exec.js';
import { LocalWorkspace } from './local.js';
import { killTree } from './process.js';

/** Where the project is mounted inside the container, and where commands start. */
export const CONTAINER_ROOT = '/workspace';
export const DEFAULT_IMAGE = 'node:24';

export interface DockerOptions {
  /** The image commands run in. It needs `sh`; bash and git are used when it has them. Default: `node:24`. */
  image?: string;
  /** `none` (default): commands get no network. `bridge` for package installs and `git push`. */
  network?: string;
  /** Limits as `docker run` takes them, e.g. `2` and `4g`. */
  cpus?: number | string;
  memory?: string;
  /** Variables for commands in the container, with their values. Nothing else from the host gets in. */
  env?: Record<string, string>;
  git?: {
    /** HTTPS `git push`: a credential helper reads the token from this variable (one of `env`). */
    tokenEnv?: string;
    /** The user name sent with the token. Default: `x-access-token`, which GitHub accepts. */
    username?: string;
    /** Author for commits, usually copied from the host's git config. */
    name?: string;
    email?: string;
  };
  /** The container CLI: `docker` (default) or a compatible one such as `podman`. */
  command?: string;
}

interface Container {
  id: string;
  shell: 'bash' | 'sh';
}

/**
 * Runs commands in a container (docs/DESIGN.md §4.12): one long-lived container per workspace,
 * started on first use, with the project mounted at `/workspace`. Files are read and written
 * through the mount, so file tools and search work on the host as in a local workspace; only
 * commands run inside. The container sees no host environment except `env`.
 */
export class DockerWorkspace implements Workspace {
  readonly kind = 'docker';
  readonly root: string;
  readonly #files: LocalWorkspace;
  readonly #image: string;
  readonly #network: string;
  readonly #cli: string;
  readonly #options: DockerOptions;
  readonly #running = new Set<{ child: ChildProcess; execId: string }>();
  #container: Promise<Container> | undefined;
  #shell: 'bash' | 'sh' = 'bash';
  #disposed = false;

  constructor(root: string, options: DockerOptions = {}) {
    this.#files = new LocalWorkspace(root);
    this.root = this.#files.root;
    this.#image = options.image ?? DEFAULT_IMAGE;
    this.#network = options.network ?? 'none';
    this.#cli = options.command ?? 'docker';
    this.#options = options;
    const tokenEnv = options.git?.tokenEnv;
    if (tokenEnv !== undefined && !(tokenEnv in (options.env ?? {}))) {
      throw new Error(
        `workspace.git.tokenEnv is "${tokenEnv}", but the container gets no such variable: add it to workspace.env.`,
      );
    }
  }

  get shell(): string {
    return `${this.#shell} (in a Docker container, image ${this.#image})`;
  }

  get description(): string {
    const network =
      this.#network === 'none'
        ? 'Commands have no network access, so they cannot download packages or push; tell the user when a task needs that.'
        : `Commands have network access (${this.#network}).`;
    return (
      `Commands run in a Docker container (image ${this.#image}), not on the user's machine. ` +
      `The project folder is mounted at ${CONTAINER_ROOT}, where commands start; use paths ` +
      `relative to it. ${network} The file tools work on the same files.`
    );
  }

  /** Starts the container in advance, so the first command does not wait for it. */
  async prepare(): Promise<void> {
    await this.#start();
  }

  resolve(path: string): string {
    return this.#files.resolve(hostPath(path));
  }

  displayPath(path: string): string {
    return this.#files.displayPath(hostPath(path));
  }

  readFile(path: string): Promise<Buffer> {
    return this.#files.readFile(hostPath(path));
  }

  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.#files.writeFile(hostPath(path), data);
  }

  removeFile(path: string): Promise<void> {
    return this.#files.removeFile(hostPath(path));
  }

  stat(path: string): Promise<FileStat | undefined> {
    return this.#files.stat(hostPath(path));
  }

  list(path: string): Promise<DirEntry[]> {
    return this.#files.list(hostPath(path));
  }

  ripgrep(args: string[], options?: { signal?: AbortSignal | undefined }): Promise<RipgrepResult> {
    return this.#files.ripgrep(args, options);
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    let container: Container;
    try {
      container = await this.#start();
    } catch (error) {
      return {
        exitCode: null,
        output: `The Docker workspace could not start: ${(error as Error).message}`,
        timedOut: false,
        durationMs: 0,
      };
    }
    const relative = this.#files.displayPath(this.resolve(options.cwd ?? '.'));
    const dir = relative === '.' ? CONTAINER_ROOT : `${CONTAINER_ROOT}/${relative}`;
    // Marks every process of this command, so a timeout or Esc can stop all of them (see #stop).
    const execId = randomUUID();
    const env = Object.entries({ ...COMMAND_ENV, HEAW_EXEC_ID: execId }).flatMap(
      ([name, value]) => ['-e', `${name}=${value}`],
    );
    const child = spawn(
      this.#cli,
      ['exec', '-w', dir, ...env, container.id, container.shell, '-c', command],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const entry = { child, execId };
    this.#running.add(entry);
    try {
      return await capture(child, {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
        onOutput: options.onOutput,
        stop: () => this.#stop(container, entry),
        startError: (error) => cliProblem(this.#cli, error),
      });
    } finally {
      this.#running.delete(entry);
    }
  }

  /** Stops running commands and removes the container. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const container = await this.#container?.catch(() => undefined);
    const stopping = [...this.#running].map((entry) => killTree(entry.child));
    this.#running.clear();
    await Promise.all(stopping);
    if (container) await this.#remove(container.id);
  }

  #start(): Promise<Container> {
    if (this.#disposed) return Promise.reject(new Error('the workspace was closed.'));
    if (!this.#container) {
      const launching = this.#launch();
      this.#container = launching;
      // A failed start is tried again by the next command, e.g. after Docker was started.
      launching.catch(() => {
        if (this.#container === launching) this.#container = undefined;
      });
    }
    return this.#container;
  }

  async #launch(): Promise<Container> {
    await this.#removeLeftovers();
    const env = this.#options.env ?? {};
    const name = `heaw-${slug(basename(this.root))}-${randomBytes(3).toString('hex')}`;
    const started = await run(
      this.#cli,
      dockerRunArgs({
        root: this.root,
        name,
        image: this.#image,
        network: this.#network,
        cpus: this.#options.cpus,
        memory: this.#options.memory,
        envNames: Object.keys(env),
        user: hostUser(),
        project: projectLabel(this.root),
        readOnly: READ_ONLY_PATHS.filter((path) => existsSync(join(this.root, path))),
      }),
      // Values travel in the CLI's environment, not its arguments, so they never show in `ps`.
      { env: { ...process.env, ...env }, timeoutMs: 15 * 60_000 },
    );
    if (started.code !== 0) {
      throw new Error(explainDockerError(this.#cli, this.#image, started.stderr || started.stdout));
    }
    const id = started.stdout.trim().split(/\s+/).at(-1) ?? name;

    const setup = await run(
      this.#cli,
      ['exec', ...gitSetupEnv(this.#options.git), id, 'sh', '-c', SETUP_SCRIPT],
      { timeoutMs: 60_000 },
    );
    if (setup.code !== 0 || this.#disposed) {
      await this.#remove(id);
      throw new Error(
        this.#disposed
          ? 'the workspace was closed.'
          : `the container started, but sh did not run in it: ${(setup.stderr || setup.stdout).trim()}`,
      );
    }
    this.#shell = setup.stdout.trim().split('\n').at(-1) === 'bash' ? 'bash' : 'sh';
    return { id, shell: this.#shell };
  }

  /**
   * Stopping the `docker exec` client does not stop the command in the container, so every
   * process carrying this command's marker variable is killed there; the client follows.
   */
  #stop(container: Container, entry: { child: ChildProcess; execId: string }): void {
    spawn(this.#cli, ['exec', container.id, 'sh', '-c', KILL_SCRIPT, 'sh', entry.execId], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => undefined);
    setTimeout(() => void killTree(entry.child), 3_000).unref();
  }

  /** Containers that an earlier heaw for this project left behind, e.g. after a crash. */
  async #removeLeftovers(): Promise<void> {
    const listed = await run(
      this.#cli,
      [
        'ps',
        '-a',
        '--filter',
        `label=heaw.project=${projectLabel(this.root)}`,
        '--format',
        '{{.ID}} {{.Label "heaw.pid"}}',
      ],
      { timeoutMs: 30_000 },
    ).catch(() => undefined);
    if (listed?.code !== 0) return;
    const stale = listed.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([id, pid]) => id && !isAlive(Number(pid)))
      .map(([id]) => id!);
    if (stale.length)
      await run(this.#cli, ['rm', '-f', ...stale], { timeoutMs: 60_000 }).catch(() => undefined);
  }

  async #remove(id: string): Promise<void> {
    await run(this.#cli, ['rm', '-f', id], { timeoutMs: 30_000 }).catch(() => undefined);
  }
}

/**
 * Mounted read-only over the project, when they exist: the files that control heaw and the git
 * hooks, which run on the host later (see PROTECTED_PATHS in core/permissions.ts, which guards
 * the file tools). Not `.git/config`: `git push -u` writes to it.
 */
export const READ_ONLY_PATHS: readonly string[] = [
  ...CONFIG_FILES,
  '.mcp.json',
  '.heaw',
  '.git/hooks',
];

/** The `docker run` arguments for a workspace container. */
export function dockerRunArgs(options: {
  root: string;
  name: string;
  image: string;
  network: string;
  cpus?: number | string | undefined;
  memory?: string | undefined;
  envNames: string[];
  user?: string | undefined;
  project: string;
  /** Paths relative to the root that commands may read but not change. */
  readOnly?: string[] | undefined;
}): string[] {
  return [
    'run',
    '--detach',
    '--rm',
    // An init process reaps the zombies that killed commands leave behind.
    '--init',
    '--name',
    options.name,
    '--label',
    'heaw=1',
    '--label',
    `heaw.project=${options.project}`,
    '--label',
    `heaw.pid=${process.pid}`,
    '--volume',
    `${options.root}:${CONTAINER_ROOT}`,
    ...(options.readOnly ?? []).flatMap((path) => [
      '--volume',
      `${join(options.root, path)}:${CONTAINER_ROOT}/${path}:ro`,
    ]),
    '--workdir',
    CONTAINER_ROOT,
    '--network',
    options.network,
    ...(options.cpus !== undefined ? ['--cpus', String(options.cpus)] : []),
    ...(options.memory ? ['--memory', options.memory] : []),
    // Under the host's user id, HOME must be somewhere that user can write.
    ...(options.user ? ['--user', options.user, '--env', 'HOME=/tmp/heaw-home'] : []),
    ...options.envNames.flatMap((name) => ['--env', name]),
    // Keeps the container alive between commands, whatever the image's own entrypoint is.
    '--entrypoint',
    'tail',
    options.image,
    '-f',
    '/dev/null',
  ];
}

/** A git credential helper that answers with the token from `tokenEnv` when git asks. */
export function credentialHelper(tokenEnv: string, username = 'x-access-token'): string {
  if (!/^[A-Za-z_]\w*$/.test(tokenEnv)) throw new Error(`"${tokenEnv}" is not a variable name.`);
  return `!f() { test "$1" = get || exit 0; echo "username=${username}"; echo "password=$${tokenEnv}"; }; f`;
}

/** `/workspace/src/a.ts`, as the model may write after running commands, means the project's file. */
function hostPath(path: string): string {
  if (path !== CONTAINER_ROOT && !path.startsWith(`${CONTAINER_ROOT}/`)) return path;
  return path.slice(CONTAINER_ROOT.length + 1) || '.';
}

/**
 * Prepares the container: a writable HOME, git that trusts the mounted repository (it belongs
 * to another user id), the host's commit author, the credential helper. Prints the shell to use.
 */
const SETUP_SCRIPT = `mkdir -p "$HOME" 2>/dev/null
if command -v git >/dev/null 2>&1; then
  git config --global --add safe.directory /workspace
  if [ -n "$HEAW_GIT_NAME" ]; then git config --global user.name "$HEAW_GIT_NAME"; fi
  if [ -n "$HEAW_GIT_EMAIL" ]; then git config --global user.email "$HEAW_GIT_EMAIL"; fi
  if [ -n "$HEAW_GIT_HELPER" ]; then git config --global credential.helper "$HEAW_GIT_HELPER"; fi
fi
if command -v bash >/dev/null 2>&1; then echo bash; else echo sh; fi`;

/** Kills every process whose environment carries the command's marker ($1). */
const KILL_SCRIPT = String.raw`for p in /proc/[0-9]*; do
  if tr '\0' '\n' < "$p/environ" 2>/dev/null | grep -qx "HEAW_EXEC_ID=$1"; then kill -9 "$(basename "$p")" 2>/dev/null; fi
done`;

function gitSetupEnv(git: DockerOptions['git']): string[] {
  const values = {
    HEAW_GIT_NAME: git?.name,
    HEAW_GIT_EMAIL: git?.email,
    HEAW_GIT_HELPER: git?.tokenEnv ? credentialHelper(git.tokenEnv, git.username) : undefined,
  };
  return Object.entries(values).flatMap(([name, value]) =>
    value ? ['-e', `${name}=${value}`] : [],
  );
}

/** On Linux, files the container writes into the project should belong to the user, not root. */
function hostUser(): string | undefined {
  if (process.platform !== 'linux' || !process.getuid || !process.getgid) return undefined;
  return `${process.getuid()}:${process.getgid()}`;
}

/** Identifies the project in container labels, without putting its path there. */
export function projectLabel(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'project'
  );
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Docker's error messages, turned into what to do about them. */
export function explainDockerError(cli: string, image: string, text: string): string {
  const message = text.trim().split('\n').slice(-3).join(' ');
  if (
    /cannot connect|failed to connect|daemon running|dockerDesktopLinuxEngine|connection refused/i.test(
      message,
    )
  ) {
    return `${cli} is installed but not running. Start Docker Desktop (or the ${cli} service) and try again.`;
  }
  if (
    /unable to find image|pull access denied|manifest unknown|repository does not exist/i.test(
      message,
    )
  ) {
    return `the image "${image}" could not be found or pulled (${message}). Check workspace.image.`;
  }
  return message || `${cli} run failed.`;
}

function cliProblem(cli: string, error: Error): string {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? `${cli} was not found. Install Docker Desktop or Docker Engine (or Podman, with workspace.command: 'podman'), or use the local workspace.`
    : `Could not run ${cli}: ${error.message}`;
}

/** Runs a container CLI command to completion. Rejects only when the CLI cannot start. */
function run(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env ?? process.env,
    });
    const stdout = new OutputBuffer(1_000_000);
    const stderr = new OutputBuffer(1_000_000);
    child.stdout.setEncoding('utf8').on('data', (text: string) => stdout.append(text));
    child.stderr.setEncoding('utf8').on('data', (text: string) => stderr.append(text));
    const timer = setTimeout(() => void killTree(child), options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(cliProblem(file, error)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout: stdout.text, stderr: stderr.text });
    });
  });
}

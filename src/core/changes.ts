import type { Workspace } from './workspace.js';

/** Larger files are listed as changed but not kept, so they cannot be rewound. */
const MAX_KEPT_BYTES = 10_000_000;

/** A file's content before the run changed it: `null` when it did not exist yet. */
type Original = Buffer | null | 'too-large';

interface Run {
  input: string;
  originals: Map<string, Original>;
  edited: Set<string>;
  /** Changed after the last command the run ran. */
  unchecked: Set<string>;
}

export interface ChangedRun {
  /** The user input that started the run. */
  input: string;
  files: string[];
}

export interface RewindReport {
  /** Runs undone, most recent first. */
  runs: ChangedRun[];
  /** Restored to their content before those runs, or removed if the runs created them. */
  restored: string[];
  /** Too large to have been kept. */
  skipped: string[];
}

/**
 * What the agent's file tools changed, run by run (docs/DESIGN.md §4.13): the files a run edited,
 * for `beforeStop` hooks, and their content before the run, for `rewind`. Only tools that write
 * a path are seen; changes made by commands are not.
 */
export class FileChanges {
  readonly #workspace: Workspace;
  readonly #runs: Run[] = [];
  #writes = 0;

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  /** A user input starts a run; what its tools change is kept apart from earlier runs. */
  startRun(input: string): void {
    this.#runs.push({ input, originals: new Map(), edited: new Set(), unchecked: new Set() });
  }

  /** Before a tool writes `path`: keeps the content it had before this run. */
  async before(path: string): Promise<void> {
    const run = this.#runs.at(-1);
    if (!run || run.originals.has(path)) return;
    const stat = await this.#workspace.stat(path).catch(() => undefined);
    if (stat?.isDirectory) return;
    if (!stat) run.originals.set(path, null);
    else if (stat.size > MAX_KEPT_BYTES) run.originals.set(path, 'too-large');
    else run.originals.set(path, await this.#workspace.readFile(path));
  }

  /** Successful writes so far: whether anything changed since a moment, e.g. a passed check. */
  get writes(): number {
    return this.#writes;
  }

  /** After a tool wrote `path` successfully. */
  after(path: string): void {
    this.#writes++;
    const run = this.#runs.at(-1);
    run?.edited.add(path);
    run?.unchecked.add(path);
  }

  /** A command ran (tests, a build, …), which may have checked the changes so far. */
  ranCommand(): void {
    this.#runs.at(-1)?.unchecked.clear();
  }

  /** Files the current run changed after the last command it ran. */
  get unchecked(): string[] {
    return [...(this.#runs.at(-1)?.unchecked ?? [])];
  }

  /** Files the current run changed, in the order it first changed them. */
  get edited(): string[] {
    return [...(this.#runs.at(-1)?.edited ?? [])];
  }

  /** Runs that changed files, oldest first. */
  runs(): ChangedRun[] {
    return this.#runs.filter((run) => run.edited.size).map(describe);
  }

  /**
   * Puts the files back as they were before the last `count` runs that changed files: files
   * those runs created are removed. Later changes to the same files (by commands or by hand)
   * are overwritten.
   */
  async rewind(count = 1): Promise<RewindReport> {
    const undone: Run[] = [];
    for (let index = this.#runs.length - 1; index >= 0 && undone.length < count; index--) {
      const run = this.#runs[index]!;
      if (!run.edited.size) continue;
      undone.push(run);
      this.#runs.splice(index, 1);
    }
    // Most recent first, so the oldest run's originals are written last and win.
    const restored = new Set<string>();
    const skipped = new Set<string>();
    for (const run of undone) {
      for (const path of run.edited) {
        const original = run.originals.get(path);
        if (original === 'too-large' || original === undefined) {
          skipped.add(path);
        } else if (original === null) {
          await this.#workspace.removeFile(path);
          restored.add(path);
        } else {
          await this.#workspace.writeFile(path, original);
          restored.add(path);
        }
      }
    }
    for (const path of restored) skipped.delete(path);
    return { runs: undone.map(describe), restored: [...restored], skipped: [...skipped] };
  }
}

function describe(run: Run): ChangedRun {
  return { input: run.input, files: [...run.edited] };
}

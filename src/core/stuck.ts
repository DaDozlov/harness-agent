import { createHash } from 'node:crypto';
import type { ToolStatus } from './tools.js';
import type { Workspace } from './workspace.js';

/** A call that fails the same way this often in one run means the agent is going in circles. */
export const SAME_FAILURES = 3;
/** A file that goes back to earlier content this often in one run: its changes go back and forth. */
export const BACK_AND_FORTH = 2;

export interface StuckSignal {
  signal: 'same-failure' | 'back-and-forth';
  /** The command, tool or file. */
  subject: string;
  count: number;
}

/**
 * Notices an agent going in circles within a run (docs/DESIGN.md §4.1), the "doom loop" of small
 * variations of the same broken fix: a call that fails the same way again and again, or a file
 * whose content goes back to what it was earlier (an edit, then its undo, then the edit again).
 * Each is reported once per run; the agent is then told to step back. Counting edits per file
 * would not do: one fix can rightly take many edits of one file.
 */
export class LoopDetector {
  readonly #workspace: Workspace;
  readonly #failures = new Map<string, number>();
  /** Per file: the hashes of the content it had in this run, the latest, and how often it went back. */
  readonly #files = new Map<string, { seen: Set<string>; last: string; returns: number }>();
  readonly #reported = new Set<string>();

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  /** A new run: what earlier runs tried does not count. */
  reset(): void {
    this.#failures.clear();
    this.#files.clear();
    this.#reported.clear();
  }

  /** Before a tool writes `path`: notes the content it had, the first time in this run. */
  async before(path: string): Promise<void> {
    if (this.#files.has(path)) return;
    const hash = await this.#hash(path);
    this.#files.set(path, { seen: new Set([hash]), last: hash, returns: 0 });
  }

  /** After a tool wrote `path`: a signal when it went back to earlier content a second time. */
  async written(path: string): Promise<StuckSignal | undefined> {
    const hash = await this.#hash(path);
    let file = this.#files.get(path);
    if (!file) {
      file = { seen: new Set(), last: '', returns: 0 };
      this.#files.set(path, file);
    }
    // A write that changed nothing is no step back.
    if (hash === file.last) return undefined;
    file.last = hash;
    if (!file.seen.has(hash)) {
      file.seen.add(hash);
      return undefined;
    }
    file.returns += 1;
    if (file.returns < BACK_AND_FORTH) return undefined;
    return this.#once(`file\u0000${path}`, {
      signal: 'back-and-forth',
      subject: path,
      count: file.returns,
    });
  }

  /** After a call: a signal when it failed the same way for the `SAME_FAILURES`th time. */
  finished(call: {
    tool: string;
    args: unknown;
    output: string;
    status: ToolStatus;
  }): StuckSignal | undefined {
    if (call.status !== 'error') return undefined;
    const command = call.tool === 'run_command' ? commandOf(call.args) : undefined;
    const key = [call.tool, command ?? '', failureKey(withoutSavedPath(call.output))].join(
      '\u0000',
    );
    const count = (this.#failures.get(key) ?? 0) + 1;
    this.#failures.set(key, count);
    if (count < SAME_FAILURES) return undefined;
    return this.#once(key, { signal: 'same-failure', subject: command ?? call.tool, count });
  }

  #once(key: string, signal: StuckSignal): StuckSignal | undefined {
    if (this.#reported.has(key)) return undefined;
    this.#reported.add(key);
    return signal;
  }

  async #hash(path: string): Promise<string> {
    const content = await this.#workspace.readFile(path).catch(() => undefined);
    return content ? createHash('sha1').update(content).digest('hex') : 'missing';
  }
}

/** What the agent is told, on the result of the call that showed it. */
export function stuckNote(stuck: StuckSignal): string {
  const what =
    stuck.signal === 'same-failure'
      ? `this failed the same way ${stuck.count} times now (${stuck.subject.includes(' ') || stuck.subject.length > 30 ? `\`${stuck.subject}\`` : stuck.subject})`
      : `${stuck.subject} is back to content it had earlier in this task, for the ${stuck.count === 2 ? 'second' : `${stuck.count}th`} time: your changes go back and forth`;
  return (
    `heaw: ${what}. Small variations of the same fix rarely help. Step back: read the whole ` +
    'error again, find its cause (read the code involved, add a check or a log line), and try a ' +
    'different approach. If you find none, stop and report what you tried.'
  );
}

/**
 * A check's output without what changes on every run (timestamps, durations), so the same
 * failure looks the same. Counts stay: "4 tests failed" after "5 tests failed" is progress.
 */
export function failureKey(feedback: string): string {
  return feedback
    .slice(-4_000)
    .replace(/\d{4}-\d\d-\d\d[T ][\d:.]+(Z|[+-]\d\d:?\d\d)?/g, '<time>')
    .replace(/\b\d\d?:\d\d(:\d\d(\.\d+)?)?\b/g, '<time>')
    .replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds|m|min)\b/g, '<duration>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-2_000);
}

/** Truncated outputs name the file the full one went to, which differs on every call. */
function withoutSavedPath(output: string): string {
  return output.replace(/\S*\/outputs\/\S+\.txt/g, '<saved output>');
}

function commandOf(args: unknown): string | undefined {
  const command = (args as { command?: unknown } | undefined)?.command;
  return typeof command === 'string' ? command.replace(/\s+/g, ' ').trim() : undefined;
}

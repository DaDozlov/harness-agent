import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
  SessionNotFoundError,
  summarize,
} from '../core/session-store.js';

/** Session ids become file names, so only safe characters are accepted. */
const SAFE_ID = /^[\w-]+$/;

/**
 * Saves each session as `.heaw/sessions/<id>.jsonl` in the project: one JSON record per line,
 * appended as the session goes (docs/DESIGN.md §4.13). The folder ignores itself in git.
 */
export class JsonlSessionStore implements SessionStore {
  readonly dir: string;
  readonly #redact: (text: string) => string;
  #ready: Promise<void> | undefined;

  /** `redact` removes secrets from each line before it is written (see `Redactor`). */
  constructor(projectRoot: string, options: { redact?: (text: string) => string } = {}) {
    this.dir = join(projectRoot, '.heaw', 'sessions');
    this.#redact = options.redact ?? ((text) => text);
  }

  async append(sessionId: string, records: SessionRecord[]): Promise<void> {
    await this.#ensureDir();
    const lines = records.map((record) => `${this.#redact(JSON.stringify(record))}\n`).join('');
    await appendFile(this.#file(sessionId), lines);
  }

  async load(sessionId: string): Promise<SessionRecord[]> {
    let text: string;
    try {
      text = await readFile(this.#file(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SessionNotFoundError(`No saved session "${sessionId}".`);
      }
      throw error;
    }
    return parseLines(text);
  }

  async list(limit = 20): Promise<SessionSummary[]> {
    const files = await this.#sessionFiles();
    const withTimes = await Promise.all(
      files.map(async (file) => ({ file, mtime: (await stat(join(this.dir, file))).mtime })),
    );
    const recent = withTimes.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const listed: SessionSummary[] = [];
    // In order, until enough: the sessions hooks ran are skipped, so a fixed slice could fall short.
    for (const { file, mtime } of recent) {
      if (listed.length >= limit) break;
      const id = file.slice(0, -'.jsonl'.length);
      const summary = summarize(
        id,
        parseLines(await readFile(join(this.dir, file), 'utf8')),
        mtime,
      );
      if (!summary.startedBy) listed.push(summary);
    }
    return listed;
  }

  async resolve(idOrPrefix: string): Promise<string> {
    const wanted = idOrPrefix.trim();
    if (!SAFE_ID.test(wanted))
      throw new SessionNotFoundError(`"${idOrPrefix}" is not a session id.`);
    const ids = (await this.#sessionFiles()).map((file) => file.slice(0, -'.jsonl'.length));
    if (ids.includes(wanted)) return wanted;
    const matches = ids.filter((id) => id.startsWith(wanted));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new SessionNotFoundError(
        `"${wanted}" matches ${matches.length} sessions (${matches.slice(0, 3).join(', ')}…). Use more of the id.`,
      );
    }
    throw new SessionNotFoundError(`No saved session matches "${wanted}".`);
  }

  #file(sessionId: string): string {
    if (!SAFE_ID.test(sessionId))
      throw new SessionNotFoundError(`"${sessionId}" is not a session id.`);
    return join(this.dir, `${sessionId}.jsonl`);
  }

  async #sessionFiles(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((file) => file.endsWith('.jsonl'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  #ensureDir(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.dir, { recursive: true });
      // Sessions contain prompts and tool output: they never belong in git.
      await writeFile(join(this.dir, '.gitignore'), '*\n');
    })();
    return this.#ready;
  }
}

/** A crash can leave a half-written last line; it is skipped rather than failing the load. */
function parseLines(text: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch {
      // Ignore the broken line.
    }
  }
  return records;
}

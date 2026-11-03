import type { Workspace } from './workspace.js';

export interface GitSummary {
  /** Undefined for a detached HEAD. */
  branch: string | undefined;
  /** `M src/a.ts`, `?? notes.md`, … as `git status --porcelain` reports them. */
  changes: string[];
}

const MAX_LISTED = 8;

/** The branch and uncommitted changes of the workspace, or undefined outside a git repository. */
export async function gitSummary(workspace: Workspace): Promise<GitSummary | undefined> {
  try {
    const result = await workspace.exec(
      'git -c core.quotepath=false status --porcelain=v1 --branch',
      { timeoutMs: 5_000 },
    );
    return result.exitCode === 0 ? parseGitStatus(result.output) : undefined;
  } catch {
    return undefined;
  }
}

export function parseGitStatus(output: string): GitSummary {
  const lines = output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean);
  const header = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  let branch: string | undefined;
  if (header.startsWith('No commits yet on ')) branch = header.slice('No commits yet on '.length);
  else if (header && !header.startsWith('HEAD (no branch)'))
    branch = header.split('...')[0]!.split(' ')[0];
  return { branch, changes: lines.map((line) => `${line.slice(0, 2).trim()} ${line.slice(3)}`) };
}

/** One line for the environment block, e.g. `branch main, 2 uncommitted changes: M a.ts, ?? b.md`. */
export function formatGitSummary(summary: GitSummary): string {
  const branch = summary.branch ? `branch ${summary.branch}` : 'detached HEAD';
  const count = summary.changes.length;
  if (!count) return `${branch}, no uncommitted changes`;
  const listed = summary.changes.slice(0, MAX_LISTED).join(', ');
  const more = count > MAX_LISTED ? `, and ${count - MAX_LISTED} more` : '';
  return `${branch}, ${count} uncommitted change${count === 1 ? '' : 's'}: ${listed}${more}`;
}

const COMMIT_HASH = /^[0-9a-f]{40,64}$/;

/** The commit work starts from, and whether there were uncommitted changes; undefined outside git. */
export async function gitState(
  workspace: Workspace,
): Promise<{ head?: string; dirty: boolean } | undefined> {
  const result = await workspace
    .exec('git rev-parse --verify -q HEAD; git status --porcelain', { timeoutMs: 5_000 })
    .catch(() => undefined);
  if (!result || result.exitCode !== 0) return undefined;
  const lines = outputLines(result.output);
  const head = COMMIT_HASH.test(lines[0] ?? '') ? lines.shift() : undefined;
  return { ...(head && { head }), dirty: lines.length > 0 };
}

/** The current commit; undefined in a repository without commits, null outside git. */
export async function gitHead(workspace: Workspace): Promise<string | undefined | null> {
  const result = await workspace
    .exec('git rev-parse --is-inside-work-tree && git rev-parse --verify -q HEAD', {
      timeoutMs: 5_000,
    })
    .catch(() => undefined);
  if (!result) return null;
  const [inside, head] = outputLines(result.output);
  if (inside !== 'true') return null;
  return head && COMMIT_HASH.test(head) ? head : undefined;
}

/**
 * Commits made on top of `base` (all of them when the repository had none) since `sinceMs`,
 * oldest first: what a run committed.
 */
export async function commitsSince(
  workspace: Workspace,
  base: string | undefined,
  sinceMs: number,
): Promise<Array<{ hash: string; subject: string }>> {
  const since = Math.floor(sinceMs / 1000) - 1;
  const range = base ? ` ${base}..HEAD` : '';
  const result = await workspace
    .exec(`git log --format=%H%x09%ct%x09%s -n 50${range}`, { timeoutMs: 5_000 })
    .catch(() => undefined);
  if (!result || result.exitCode !== 0) return [];
  return outputLines(result.output)
    .flatMap((line) => {
      const [hash = '', time, ...subject] = line.split('\t');
      return COMMIT_HASH.test(hash) && Number(time) >= since
        ? [{ hash, subject: subject.join('\t') }]
        : [];
    })
    .reverse();
}

function outputLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean);
}

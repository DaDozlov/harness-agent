import { findProjectRoot } from '../../config/project.js';
import type { SessionSummary } from '../../core/session-store.js';
import { formatTable, localTime } from '../../evals/format.js';
import { JsonlSessionStore } from '../../sessions/jsonl-store.js';
import { formatCost } from '../format.js';
import type { Output } from './run.js';

/**
 * `heaw sessions`: saved sessions with what they were for, what they cost, and the pull requests
 * and commits they produced (docs/DESIGN.md §4.13), to join with what happened to those changes.
 */
export async function sessionsCommand(
  options: { limit?: number; json?: boolean },
  context: { cwd: string; stdout: Output },
): Promise<number> {
  const store = new JsonlSessionStore(findProjectRoot(context.cwd));
  const sessions = await store.list(options.limit ?? 20);
  if (options.json) {
    context.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return 0;
  }
  if (!sessions.length) {
    context.stdout.write('No saved sessions in this project yet (.heaw/sessions/).\n');
    return 0;
  }
  context.stdout.write(`${formatSessions(sessions)}\n`);
  return 0;
}

export function formatSessions(sessions: SessionSummary[]): string {
  const header = ['id', 'started', 'intent', 'runs', 'cost', 'produced', 'first message'];
  const rows = sessions.map((session) => [
    session.id,
    localTime(session.createdAt),
    session.intent ?? '—',
    String(session.runs),
    session.costUsd === undefined ? '—' : formatCost(session.costUsd),
    produced(session),
    session.title.length > 50 ? `${session.title.slice(0, 49)}…` : session.title,
  ]);
  const hint = 'Pull request URLs and commit hashes: --json';
  return [...formatTable(header, rows), '', hint].join('\n');
}

function produced(session: SessionSummary): string {
  const parts = [
    session.pullRequests.length && plural(session.pullRequests.length, 'PR'),
    session.commits.length && plural(session.commits.length, 'commit'),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

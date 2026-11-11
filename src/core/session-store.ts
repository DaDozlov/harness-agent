import { randomBytes } from 'node:crypto';
import type { EngineEvent } from './events.js';
import { type Message, textOf } from './messages.js';
import { addUsage, emptyUsage, type Usage } from './usage.js';
import { UsageStats } from './usage-stats.js';

/** The first record of every saved session. */
export interface SessionHeader {
  type: 'session';
  version: 1;
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  /** What the session is for, e.g. build, explore or ask. */
  intent?: string;
  /** The commit the session started from, and whether there were uncommitted changes then. */
  git?: { head?: string; dirty: boolean };
  /**
   * The conversation whose hook ran this one (a tester in `beforeStop`). Kept for audits and
   * `/retro`, and left out of session lists: it is part of that conversation, not one of its own.
   */
  startedBy?: string;
}

/**
 * A saved session is an append-only list of records (docs/DESIGN.md §4.13). `message` records
 * rebuild the history; `event` records keep what happened, for display and audits. Streaming
 * deltas are not saved: the complete messages already contain their text.
 */
export type SessionRecord =
  | SessionHeader
  | { type: 'message'; timestamp: number; message: Message }
  /** The history after a compaction; it replaces every message before it. */
  | { type: 'compaction'; timestamp: number; messages: Message[] }
  | { type: 'event'; event: EngineEvent };

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  /** The first user message, shortened. */
  title: string;
  messages: number;
  /** Runs, i.e. user inputs the agent worked on. */
  runs: number;
  intent?: string;
  /** Missing when no model call could be priced. */
  costUsd?: number;
  /** Pull requests the session opened, by URL. */
  pullRequests: string[];
  /** Commits its runs made, oldest first. */
  commits: Array<{ hash: string; subject: string }>;
  /** The commit it started from, and whether there were uncommitted changes then. */
  git?: { head?: string; dirty: boolean };
  /** The conversation whose hook ran it (see `SessionHeader.startedBy`). */
  startedBy?: string;
}

/** Where sessions are saved. The default writes JSONL files to `.heaw/sessions/`. */
export interface SessionStore {
  append(sessionId: string, records: SessionRecord[]): Promise<void>;
  load(sessionId: string): Promise<SessionRecord[]>;
  /**
   * Most recently updated first, without the sessions hooks ran (`startedBy`): those belong to
   * the conversation that ran them, and are loaded by id.
   */
  list(limit?: number): Promise<SessionSummary[]>;
  /** The full id for an id or a unique prefix of one. */
  resolve(idOrPrefix: string): Promise<string>;
}

export class SessionNotFoundError extends Error {
  override readonly name = 'SessionNotFoundError';
}

/** Readable and sortable by time, e.g. `20261030-141523-k3f9`. */
export function createSessionId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4);
  return `${date}-${time}-${suffix}`;
}

export interface RestoredSession {
  header: SessionHeader | undefined;
  messages: Message[];
  usage: Usage;
  /** Missing when no run could be priced. */
  costUsd?: number;
  /** Where its tokens went so far. */
  stats: UsageStats;
}

/** What a session needs to continue: its history and the usage and cost so far. */
export function restoreSession(records: SessionRecord[]): RestoredSession {
  let header: SessionHeader | undefined;
  let messages: Message[] = [];
  let usage = emptyUsage();
  let costUsd: number | undefined;
  const stats = new UsageStats();
  for (const record of records) {
    if (record.type === 'event') stats.add(record.event);
    if (record.type === 'session') header = record;
    else if (record.type === 'message') messages.push(record.message);
    else if (record.type === 'compaction') messages = [...record.messages];
    // Every model call has a usage event, inside runs or not (a manual compaction).
    else if (record.event.type === 'usage') {
      usage = addUsage(usage, record.event.usage);
      if (record.event.costUsd !== undefined) costUsd = (costUsd ?? 0) + record.event.costUsd;
    }
  }
  return {
    header,
    messages: withAnsweredToolCalls(messages),
    usage,
    ...(costUsd !== undefined && { costUsd }),
    stats,
  };
}

export function summarize(id: string, records: SessionRecord[], updatedAt: Date): SessionSummary {
  const header = records.find((record): record is SessionHeader => record.type === 'session');
  const messages = records.filter((record) => record.type === 'message');
  const firstUser = messages.find((record) => record.message.role === 'user');
  const title = firstUser ? textOf(firstUser.message).replace(/\s+/g, ' ').trim() : '';
  const events = records.flatMap((record) => (record.type === 'event' ? [record.event] : []));
  const links = (kind: 'pull_request' | 'commit') =>
    events.flatMap((event) => (event.type === 'link' && event.kind === kind ? [event] : []));
  const { costUsd } = restoreSession(records);
  return {
    id,
    createdAt: header?.createdAt ?? updatedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    model: header?.model ?? 'unknown',
    title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
    messages: messages.length,
    // The user's agent only: sub-agent runs are part of its runs.
    runs: events.filter((event) => event.type === 'run.start' && !event.parentAgentId).length,
    ...(header?.intent && { intent: header.intent }),
    ...(costUsd !== undefined && { costUsd }),
    pullRequests: [...new Set(links('pull_request').map((link) => link.ref))],
    commits: links('commit').map((link) => ({ hash: link.ref, subject: link.title ?? '' })),
    ...(header?.git && { git: header.git }),
    ...(header?.startedBy && { startedBy: header.startedBy }),
  };
}

/**
 * A session that ended abruptly (crash, killed process) can end with tool calls that never got
 * results. Providers reject such a history, so the missing results are filled in.
 */
function withAnsweredToolCalls(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return messages;
  const calls = last.content.filter((part) => part.type === 'tool-call');
  if (!calls.length) return messages;
  return [
    ...messages,
    {
      role: 'tool',
      content: calls.map((call) => ({
        type: 'tool-result' as const,
        callId: call.id,
        name: call.name,
        output: 'Not run: the session ended before this call finished.',
        isError: true,
      })),
    },
  ];
}

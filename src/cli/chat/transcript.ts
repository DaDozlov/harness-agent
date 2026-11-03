import { SUMMARY_PREFIX } from '../../core/context.js';
import type { SerializedError } from '../../core/errors.js';
import type { EngineEvent, HookName, StopReason } from '../../core/events.js';
import { type Message, textOf } from '../../core/messages.js';
import type { ToolStatus } from '../../core/tools.js';
import { addUsage, type Usage } from '../../core/usage.js';
import { type TodoItem, todosIn } from '../../tools/todo.js';
import { formatTokens, toolLabel } from '../format.js';

function todosOf(tool: string, args: unknown): { todos?: TodoItem[] } {
  const todos = tool === 'todo_write' ? todosIn(args) : undefined;
  return todos ? { todos } : {};
}

export type ToolItemStatus = ToolStatus | 'running' | 'approval';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; done: boolean }
  | {
      kind: 'tool';
      id: string;
      callId: string;
      tool: string;
      label: string;
      status: ToolItemStatus;
      output?: string;
      durationMs?: number;
      /** The task list a todo_write call set, shown as a checklist. */
      todos?: TodoItem[];
      /** The sub-agent that made the call; missing for the user's agent. */
      agent?: string;
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'warning' | 'error' };

/**
 * What the chat shows. Items before `committed` are final and rendered once, above the live
 * area (Ink's <Static>); later items can still change (streaming text, running tools).
 */
export interface TranscriptState {
  items: TranscriptItem[];
  committed: number;
  /** Usage of the current session. */
  usage: Usage;
  /** Cost of the current session in USD; undefined while no call could be priced. */
  costUsd: number | undefined;
  /** Names of the sub-agents seen so far, by agent id. */
  agents: Record<string, string>;
  nextId: number;
  /** Whether the current model message arrived as deltas (then it is already on screen). */
  streamed: boolean;
}

export type TranscriptAction =
  | { type: 'user'; text: string }
  | { type: 'notice'; text: string; tone?: 'info' | 'warning' | 'error' }
  | { type: 'event'; event: EngineEvent }
  | { type: 'usage'; usage: Usage; costUsd: number | undefined };

export function createTranscript(
  usage: Usage,
  items: TranscriptItem[] = [],
  costUsd?: number,
): TranscriptState {
  return commit({
    items,
    committed: 0,
    usage,
    costUsd,
    agents: {},
    nextId: items.length,
    streamed: false,
  });
}

export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.type) {
    case 'user':
      return commit(push(state, (id) => ({ kind: 'user', id, text: action.text })));
    case 'notice':
      return commit(
        push(state, (id) => ({
          kind: 'notice',
          id,
          text: action.text,
          tone: action.tone ?? 'info',
        })),
      );
    case 'usage':
      return { ...state, usage: action.usage, costUsd: action.costUsd };
    case 'event':
      return commit(applyEvent(state, action.event));
  }
}

/** Sub-agents' streaming and bookkeeping stay out of the transcript; their report is a tool result. */
const QUIET_FOR_SUBAGENTS = new Set<EngineEvent['type']>([
  'run.start',
  'run.end',
  'turn.start',
  'text.delta',
  'reasoning.delta',
  'message.complete',
]);

/** Tool calls are told apart by agent too: sub-agents' call ids can repeat the parent's. */
const toolKey = (event: { agentId: string; callId: string }) => `${event.agentId}:${event.callId}`;

function applyEvent(state: TranscriptState, event: EngineEvent): TranscriptState {
  const agent =
    event.parentAgentId === undefined ? undefined : (state.agents[event.agentId] ?? event.agentId);
  if (agent && QUIET_FOR_SUBAGENTS.has(event.type)) return state;
  const from = agent ? `${agent}: ` : '';
  switch (event.type) {
    case 'subagent.start':
      return { ...state, agents: { ...state.agents, [event.childAgentId]: event.name } };
    case 'text.delta': {
      const last = state.items.at(-1);
      const open = last?.kind === 'assistant' && !last.done;
      const text = (open ? last.text : '') + event.text;
      const base = open ? { ...state, items: state.items.slice(0, -1) } : state;
      return withStreamingText({ ...base, streamed: true }, text);
    }
    case 'message.complete': {
      // Text that arrived without deltas (non-streaming providers) still has to show.
      const text = textOf(event.message);
      const closed = { ...closeAssistant(state), streamed: false };
      return !state.streamed && text
        ? push(closed, (id) => ({ kind: 'assistant', id, text, done: true }))
        : closed;
    }
    case 'tool.start':
      return push(state, (id) => ({
        kind: 'tool',
        id,
        callId: toolKey(event),
        tool: event.tool,
        label: toolLabel(event.tool, event.args),
        status: 'running',
        ...todosOf(event.tool, event.args),
        ...(agent && { agent }),
      }));
    case 'approval.request':
      return updateTool(state, toolKey(event), (item) => ({ ...item, status: 'approval' }));
    case 'approval.response':
      return state.items.some((item) => item.kind === 'tool' && item.status === 'approval')
        ? mapItems(state, (item) =>
            item.kind === 'tool' && item.status === 'approval'
              ? { ...item, status: 'running' }
              : item,
          )
        : state;
    case 'tool.end':
      return updateTool(state, toolKey(event), (item) => ({
        ...item,
        status: event.status,
        output: event.output,
        durationMs: event.durationMs,
      }));
    case 'usage':
      return {
        ...state,
        usage: addUsage(state.usage, event.usage),
        costUsd: event.costUsd === undefined ? state.costUsd : (state.costUsd ?? 0) + event.costUsd,
      };
    case 'compaction':
      return push(state, (id) => ({
        kind: 'notice',
        id,
        tone: 'info',
        text: from + describeCompaction(event),
      }));
    case 'hook':
      return push(state, (id) => ({
        kind: 'notice',
        id,
        tone: event.hook === 'userPrompt' ? 'warning' : 'info',
        text: from + describeHook(event.hook, event.message),
      }));
    case 'error':
      return push(state, (id) => ({
        kind: 'notice',
        id,
        tone: event.recoverable ? 'warning' : 'error',
        text: from + describeError(event.error, event.recoverable),
      }));
    case 'run.end': {
      const closed = closeAssistant(state);
      const note = STOP_NOTES[event.stopReason];
      return note
        ? push(closed, (id) => ({ kind: 'notice', id, tone: note.tone, text: note.text }))
        : closed;
    }
    default:
      return state;
  }
}

const STOP_NOTES: Partial<Record<StopReason, { text: string; tone: 'info' | 'warning' }>> = {
  aborted: { text: 'Interrupted.', tone: 'info' },
  max_tokens: {
    text: 'The answer reached the model output limit and may be cut off.',
    tone: 'warning',
  },
  max_turns: {
    text: 'Stopped: reached the maximum number of turns for one message.',
    tone: 'warning',
  },
  token_limit: { text: 'Stopped: this message reached its token limit.', tone: 'warning' },
  cost_limit: { text: 'Stopped: this message reached its cost limit.', tone: 'warning' },
  time_limit: { text: 'Stopped: this message reached its time limit.', tone: 'warning' },
  content_filter: { text: "The provider's content filter blocked the answer.", tone: 'warning' },
};

/**
 * Adds streaming text as finished paragraphs plus one open tail. Finished paragraphs are final,
 * so they move out of the live area right away: Ink cannot redraw a live area taller than the
 * terminal (lines that scrolled away cannot be erased, so every update would print a new copy).
 */
function withStreamingText(state: TranscriptState, text: string): TranscriptState {
  const split = splitFinishedParagraphs(text);
  const finished = split
    ? push(state, (id) => ({ kind: 'assistant', id, text: split.finished, done: true }))
    : state;
  const tail = split ? split.tail : text;
  return tail
    ? push(finished, (id) => ({ kind: 'assistant', id, text: tail, done: false }))
    : finished;
}

/**
 * Splits at the last blank line that is not inside a code block. Splitting inside a fenced block
 * would break its rendering, so a block stays in the tail until it closes.
 */
export function splitFinishedParagraphs(
  text: string,
): { finished: string; tail: string } | undefined {
  for (
    let index = text.lastIndexOf('\n\n');
    index > 0;
    index = text.lastIndexOf('\n\n', index - 1)
  ) {
    const finished = text.slice(0, index);
    if (finished.trim() && (finished.match(/^[ \t]*(?:```|~~~)/gm) ?? []).length % 2 === 0) {
      return { finished, tail: text.slice(index).replace(/^\n+/, '') };
    }
  }
  return undefined;
}

/** Turns a restored history into transcript items, so a resumed chat shows what came before. */
export function itemsFromHistory(messages: Message[]): TranscriptItem[] {
  const results = new Map<string, { output: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      results.set(part.callId, { output: part.output, isError: part.isError ?? false });
    }
  }

  const items: TranscriptItem[] = [];
  const id = () => `history-${items.length}`;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user' && textOf(message).startsWith(SUMMARY_PREFIX)) {
      items.push({
        kind: 'notice',
        id: id(),
        tone: 'info',
        text: 'Earlier turns were summarized.',
      });
      continue;
    }
    if (message.role === 'user') items.push({ kind: 'user', id: id(), text: textOf(message) });
    if (message.role !== 'assistant') continue;
    // The acknowledgement that follows a summary is bookkeeping, not part of the conversation.
    const previous = messages[index - 1];
    if (previous?.role === 'user' && textOf(previous).startsWith(SUMMARY_PREFIX)) continue;
    for (const part of message.content) {
      if (part.type === 'text' && part.text) {
        items.push({ kind: 'assistant', id: id(), text: part.text, done: true });
      }
      if (part.type === 'tool-call') {
        const result = results.get(part.id);
        items.push({
          kind: 'tool',
          id: id(),
          callId: part.id,
          tool: part.name,
          label: toolLabel(part.name, part.args),
          status: !result ? 'cancelled' : result.isError ? 'error' : 'ok',
          ...(result && { output: result.output }),
          ...todosOf(part.name, part.args),
        });
      }
    }
  }
  return items;
}

function describeCompaction(event: Extract<EngineEvent, { type: 'compaction' }>): string {
  const how = event.method === 'summary' ? 'older turns summarized' : 'old tool outputs cleared';
  const sizes = `${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} tokens`;
  return `Context compacted${event.trigger === 'auto' ? ' to fit the window' : ''}: ${sizes}, ${how}.`;
}

function describeHook(hook: HookName, message: string): string {
  if (hook === 'userPrompt') return `Blocked by a userPrompt hook: ${message}`;
  if (hook === 'beforeStop') {
    const first = message.split('\n').find((line) => line.trim()) ?? message;
    return `A check before finishing failed, so the agent keeps working: ${first}`;
  }
  return `${hook} hook: ${message}`;
}

/** Only model errors are retried; other recoverable errors are reported as they are. */
function describeError(error: SerializedError, recoverable: boolean): string {
  const status = error.status ? ` (${error.status})` : '';
  if (!recoverable) return `Error${status}: ${error.message}`;
  if (OWN_ERRORS.has(error.name)) return error.message;
  return `Model call failed${status}, retrying: ${error.message}`;
}

const OWN_ERRORS = new Set(['SessionSaveError', 'HookError', 'CompactionError']);

export function isFinal(item: TranscriptItem): boolean {
  if (item.kind === 'assistant') return item.done;
  if (item.kind === 'tool') return item.status !== 'running' && item.status !== 'approval';
  return true;
}

function commit(state: TranscriptState): TranscriptState {
  let committed = state.committed;
  while (committed < state.items.length && isFinal(state.items[committed]!)) committed++;
  return committed === state.committed ? state : { ...state, committed };
}

function push(state: TranscriptState, create: (id: string) => TranscriptItem): TranscriptState {
  return {
    ...state,
    items: [...state.items, create(`item-${state.nextId}`)],
    nextId: state.nextId + 1,
  };
}

function replaceLast(state: TranscriptState, item: TranscriptItem): TranscriptState {
  return { ...state, items: [...state.items.slice(0, -1), item] };
}

function mapItems(
  state: TranscriptState,
  map: (item: TranscriptItem) => TranscriptItem,
): TranscriptState {
  return { ...state, items: state.items.map(map) };
}

function closeAssistant(state: TranscriptState): TranscriptState {
  const last = state.items.at(-1);
  return last?.kind === 'assistant' && !last.done
    ? replaceLast(state, { ...last, done: true })
    : state;
}

function updateTool(
  state: TranscriptState,
  callId: string,
  update: (item: Extract<TranscriptItem, { kind: 'tool' }>) => TranscriptItem,
): TranscriptState {
  return mapItems(state, (item) =>
    item.kind === 'tool' && item.callId === callId ? update(item) : item,
  );
}

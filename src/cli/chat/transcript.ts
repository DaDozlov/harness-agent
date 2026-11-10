import { SUMMARY_PREFIX } from '../../core/context.js';
import type { SerializedError } from '../../core/errors.js';
import type { EngineEvent, HookName, StopReason } from '../../core/events.js';
import { type Message, textOf } from '../../core/messages.js';
import type { ToolStatus } from '../../core/tools.js';
import { addUsage, type Usage } from '../../core/usage.js';
import { type TodoItem, todosIn } from '../../tools/todo.js';
import { describeNearLimit, describeStuck, formatTokens, toolLabel } from '../format.js';

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
      /** The sub-agent that made the call, as shown (`ui-builder 2`); missing for the user's agent. */
      agent?: string;
      agentColor?: string;
      /** For a running delegate call: its sub-agent and how far it got. */
      progress?: { agent: string; color: string; calls: number; last?: string };
    }
  /**
   * A sub-agent started; its calls follow, indented and labelled with its name. `open` until its
   * first call, so a namesake starting in the same turn can still number it.
   */
  | {
      kind: 'agent';
      id: string;
      agentId: string;
      label: string;
      color: string;
      task: string;
      open: boolean;
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'warning' | 'error' };

/** How the chat shows a sub-agent. */
export interface SubagentView {
  name: string;
  /** The name, numbered while others with the same name run (`ui-builder 2`). */
  label: string;
  number?: number;
  color: string;
  /** The delegate call that started it (its transcript key). */
  delegate?: string;
  running: boolean;
}

/**
 * What the chat shows. Items before `committed` are final and rendered once, above the live
 * area (Ink's <Static>); the others can still change (streaming text, running tools).
 */
export interface TranscriptState {
  items: TranscriptItem[];
  committed: number;
  /** Usage of the current session. */
  usage: Usage;
  /** Cost of the current session in USD; undefined while no call could be priced. */
  costUsd: number | undefined;
  /** The sub-agents seen so far, by agent id. */
  agents: Record<string, SubagentView>;
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
  const view = event.parentAgentId === undefined ? undefined : state.agents[event.agentId];
  const agent = event.parentAgentId === undefined ? undefined : (view?.label ?? event.agentId);
  if (agent && QUIET_FOR_SUBAGENTS.has(event.type)) return state;
  const from = agent ? `${agent}: ` : '';
  switch (event.type) {
    case 'subagent.start':
      return startSubagent(state, event);
    case 'subagent.end': {
      const ended = withAgent(
        closeAgentLine(state, event.childAgentId),
        event.childAgentId,
        (view) => view && { ...view, running: false },
      );
      // An agent a hook ran (a tester, a reviewer) has no delegate call to report on: its last
      // line, usually a verdict, is shown instead.
      if (!event.summary) return ended;
      const done = event.stopReason === 'end_turn';
      const text = `${event.name}: ${event.summary}${done ? '' : ` (stopped: ${event.stopReason})`}`;
      return push(ended, (id) => ({ kind: 'notice', id, text, tone: done ? 'info' : 'warning' }));
    }
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
      return startTool(state, event, view);
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
    case 'limit.near':
      // A sub-agent near its limit wraps up and says so in its report.
      return agent
        ? state
        : push(state, (id) => ({
            kind: 'notice',
            id,
            tone: 'warning',
            text: describeNearLimit(event),
          }));
    case 'stuck':
      return push(state, (id) => ({
        kind: 'notice',
        id,
        tone: 'warning',
        text: from + describeStuck(event),
      }));
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
        text:
          from +
          (event.builtIn
            ? `Not done yet, so the agent goes on: ${shorten(event.message, 200)}`
            : event.passed
              ? `Checks passed; the agent adds what they found: ${shorten(event.message, 200)}`
              : describeHook(event.hook, event.message)),
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

/** Sub-agents running at the same time get different colors. */
const AGENT_COLORS = ['magenta', 'cyan', 'yellow', 'blue', 'green'];

/**
 * A sub-agent starts: it gets a label, numbered while another with the same name runs
 * (`ui-builder 1`, `ui-builder 2`), and a color no running sub-agent has. A line with its task
 * marks where its calls begin, and its delegate call starts counting them.
 */
function startSubagent(
  state: TranscriptState,
  event: Extract<EngineEvent, { type: 'subagent.start' }>,
): TranscriptState {
  const running = Object.entries(state.agents).filter(([, view]) => view.running);
  const namesakes = running.filter(([, view]) => view.name === event.name);
  let next = state;
  for (const [id, view] of namesakes.filter(([, other]) => other.number === undefined)) {
    next = relabel(next, id, { ...view, number: 1, label: `${view.name} 1` });
  }
  const numbers = namesakes.map(([, view]) => view.number ?? 1);
  const number = numbers.length ? Math.max(...numbers) + 1 : undefined;
  const used = new Set(running.map(([, view]) => view.color));
  const color =
    AGENT_COLORS.find((candidate) => !used.has(candidate)) ??
    AGENT_COLORS[Object.keys(state.agents).length % AGENT_COLORS.length]!;
  const view: SubagentView = {
    name: event.name,
    label: number === undefined ? event.name : `${event.name} ${number}`,
    ...(number !== undefined && { number }),
    color,
    ...(event.callId !== undefined && { delegate: toolKey({ ...event, callId: event.callId }) }),
    running: true,
  };
  next = relabel(next, event.childAgentId, view);
  return push(next, (id) => ({
    kind: 'agent',
    id,
    agentId: event.childAgentId,
    label: view.label,
    color,
    task: shorten(event.task, 100),
    open: true,
  }));
}

/** Sets how a sub-agent is shown: its line if still open, and its delegate call while that runs. */
function relabel(state: TranscriptState, agentId: string, view: SubagentView): TranscriptState {
  const next = mapItems(
    withAgent(state, agentId, () => view),
    (item) =>
      item.kind === 'agent' && item.agentId === agentId && item.open
        ? { ...item, label: view.label }
        : item,
  );
  if (!view.delegate) return next;
  return updateTool(next, view.delegate, (item) =>
    item.status === 'running' || item.status === 'approval'
      ? {
          ...item,
          progress: {
            calls: item.progress?.calls ?? 0,
            ...item.progress,
            agent: view.label,
            color: view.color,
          },
        }
      : item,
  );
}

/** A sub-agent's first call (or its end) fixes its line, which can then be printed for good. */
function closeAgentLine(state: TranscriptState, agentId: string): TranscriptState {
  const open = state.items.some(
    (item) => item.kind === 'agent' && item.agentId === agentId && item.open,
  );
  return open
    ? mapItems(state, (item) =>
        item.kind === 'agent' && item.agentId === agentId ? { ...item, open: false } : item,
      )
    : state;
}

function withAgent(
  state: TranscriptState,
  agentId: string,
  change: (view: SubagentView | undefined) => SubagentView | undefined,
): TranscriptState {
  const view = change(state.agents[agentId]);
  return view ? { ...state, agents: { ...state.agents, [agentId]: view } } : state;
}

/** A tool call starts; a sub-agent's also counts on the delegate call that started it. */
function startTool(
  state: TranscriptState,
  event: Extract<EngineEvent, { type: 'tool.start' }>,
  view: SubagentView | undefined,
): TranscriptState {
  const label = toolLabel(event.tool, event.args);
  const opened = event.parentAgentId === undefined ? state : closeAgentLine(state, event.agentId);
  const counted = view?.delegate
    ? updateTool(opened, view.delegate, (item) =>
        item.progress
          ? { ...item, progress: { ...item.progress, calls: item.progress.calls + 1, last: label } }
          : item,
      )
    : opened;
  return push(counted, (id) => ({
    kind: 'tool',
    id,
    callId: toolKey(event),
    tool: event.tool,
    label,
    status: 'running',
    ...todosOf(event.tool, event.args),
    ...(event.parentAgentId !== undefined && {
      agent: view?.label ?? event.agentId,
      ...(view && { agentColor: view.color }),
    }),
  }));
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
  check_failed: {
    text:
      'Stopped: a check before finishing failed the same way 3 times, so the agent is stuck or ' +
      'the check cannot run here. Fix what it reports, or the check (heaw.config.ts, then /reload).',
    tone: 'warning',
  },
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
    const texts: string[] = [];
    for (const part of message.content) {
      // A final answer that repeats a progress message of the same response is shown once.
      if (part.type === 'text' && part.text && !texts.some((text) => text.startsWith(part.text))) {
        texts.push(part.text);
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

function shorten(text: string, length: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > length ? `${oneLine.slice(0, length)}…` : oneLine;
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
  if (item.kind === 'agent') return !item.open;
  return true;
}

/**
 * Moves final items out of the live area, also past items that are still running (a delegate
 * call whose sub-agent works for minutes): Ink cannot redraw a live area taller than the
 * terminal, and every update then printed a new copy of it. Running items stay below, in order.
 */
function commit(state: TranscriptState): TranscriptState {
  const open = state.items.slice(state.committed);
  const final = open.filter(isFinal);
  if (!final.length) return state;
  return {
    ...state,
    items: [
      ...state.items.slice(0, state.committed),
      ...final,
      ...open.filter((item) => !isFinal(item)),
    ],
    committed: state.committed + final.length,
  };
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

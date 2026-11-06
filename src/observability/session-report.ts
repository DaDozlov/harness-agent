import { z } from 'zod';
import type { EngineEvent } from '../core/events.js';
import { textOf } from '../core/messages.js';
import type {
  SessionHeader,
  SessionRecord,
  SessionStore,
  SessionSummary,
} from '../core/session-store.js';
import { failureKey } from '../core/stuck.js';
import type { Tool } from '../core/tools.js';
import { defineTool } from '../tools/define.js';

/** Entries shown per list, so a long session still fits in one tool result. */
const MAX_ITEMS = 8;
/** Lines of a run's step-by-step list; the middle of a longer one is left out. */
const MAX_STEPS = 400;
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

type Of<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

interface Run {
  /** 1-based, in order. */
  number: number;
  start: Of<'run.start'>;
  end: Of<'run.end'> | undefined;
  /** Record indexes of its `run.start` and its `run.end` (or the log's end). */
  from: number;
  to: number;
}

/**
 * `session_report`: a saved session condensed for a review of how the agent worked (the `retro`
 * skill, docs/DESIGN.md §4.8): what it cost, what failed, repeated or was asked again and again,
 * what sent it back, and what the user had to correct. Reading the raw log would fill the
 * context many times over.
 */
export function sessionReportTool(store: SessionStore): Tool {
  return defineTool({
    name: 'session_report',
    description:
      'Summarize a saved heaw session of this project for a review of how the agent worked ' +
      "(/retro): its runs with what each cost, the user's corrections and denials, failed and " +
      'repeated calls, approvals asked again and again, checks that sent the agent back, ' +
      'sub-agents, and what filled the context. Without `session`: this conversation if it had ' +
      'earlier messages, otherwise the latest saved session. With `run`: that run step by step.',
    kind: 'read',
    parameters: z.object({
      session: z
        .string()
        .optional()
        .describe('A session id or the start of one (default: see the description)'),
      run: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('List this run, numbered as in the summary, step by step'),
    }),
    async run({ session, run }, { agent, signal }) {
      const current = agent?.hookContext(signal).sessionId;
      const recent = await store.list(12);
      let id: string | undefined;
      try {
        id = session ? await store.resolve(session) : defaultSession(recent, current);
      } catch (error) {
        return { output: (error as Error).message, isError: true };
      }
      if (!id) return 'There are no saved sessions in this project yet.';
      let records = await store.load(id);
      // This conversation's run in progress is the review itself.
      if (id === current) records = withoutUnfinishedRun(records);
      if (run !== undefined) return runSteps(records, run);
      const others = recent.filter((summary) => summary.id !== id).slice(0, 5);
      return sessionReport(id, records) + otherSessions(others);
    },
  });
}

/** This conversation when it had earlier runs (one is this review), else the latest other one. */
function defaultSession(recent: SessionSummary[], current: string | undefined): string | undefined {
  const own = recent.find((summary) => summary.id === current);
  if (own && own.runs >= 2) return own.id;
  return recent.find((summary) => summary.id !== current)?.id;
}

function withoutUnfinishedRun(records: SessionRecord[]): SessionRecord[] {
  const runs = runsOf(records);
  const last = runs.at(-1);
  return last && !last.end ? records.slice(0, last.from) : records;
}

/** The overview of a session: its runs, then what needs a look. */
export function sessionReport(id: string, records: SessionRecord[]): string {
  const header = records.find((record): record is SessionHeader => record.type === 'session');
  const events = eventsOf(records);
  const runs = runsOf(records);
  const calls = callsOf(events);
  const sections = [
    overview(id, header, events, runs),
    runList(runs, records),
    userCorrections(runs, events, calls),
    failedCalls(events, calls),
    repeatedApprovals(events),
    sentBack(events, runs),
    steppedIn(events),
    repeatedCalls(events),
    oneChangePerResponse(events),
    subagents(events),
    contextFillers(events, calls),
    filesChanged(events),
    errors(events),
    links(events),
  ].filter((section): section is string => Boolean(section));
  return `${sections.join('\n\n')}\n\nCall session_report with \`run\` to see one run step by step.`;
}

function overview(
  id: string,
  header: SessionHeader | undefined,
  events: EngineEvent[],
  runs: Run[],
): string {
  const usages = events.filter((event): event is Of<'usage'> => event.type === 'usage');
  const input = sum(usages.map((event) => event.usage.inputTokens));
  const cached = sum(usages.map((event) => event.usage.cacheReadTokens));
  const output = sum(usages.map((event) => event.usage.outputTokens));
  const priced = usages.filter((event) => event.costUsd !== undefined);
  const cost = priced.length
    ? money(sum(priced.map((event) => event.costUsd ?? 0)))
    : 'cost unknown';
  const models = [...new Set(usages.flatMap((event) => (event.model ? [event.model] : [])))];
  const largest = Math.max(0, ...usages.map((event) => event.usage.inputTokens));
  const mainTurns = sum(runs.map((run) => run.end?.turns ?? 0));
  const subTurns = sum(
    events.flatMap((event) => (event.type === 'subagent.end' ? [event.turns] : [])),
  );
  const worked = sum(runs.map((run) => (run.end ? run.end.timestamp - run.start.timestamp : 0)));
  const started = header ? ` started ${clock(Date.parse(header.createdAt), true)}` : '';
  const git = header?.git?.head
    ? `, from commit ${header.git.head.slice(0, 7)}${header.git.dirty ? ' with uncommitted changes' : ''}`
    : '';
  return [
    `# Session ${id}`,
    `${started.trim()}${header?.intent ? `, intent ${header.intent}` : ''}${git}; model ${models.join(', ') || header?.model || 'unknown'}`,
    `${runs.length} run${runs.length === 1 ? '' : 's'} · ${mainTurns} turns of the main agent` +
      (subTurns ? `, ${subTurns} of sub-agents` : '') +
      ` · ${usages.length} model calls (largest request ${tokens(largest)} tokens) · ` +
      `${tokens(input)} tokens in (${input ? Math.round((100 * cached) / input) : 0}% cached), ` +
      `${tokens(output)} out · ${cost} · ${duration(worked)} of work`,
  ].join('\n');
}

function runList(runs: Run[], records: SessionRecord[]): string | undefined {
  if (!runs.length) return undefined;
  const lines = runs.map((run) => {
    const inside = eventsOf(records.slice(run.from, run.to + 1));
    const count = (type: EngineEvent['type']) =>
      inside.filter((event) => event.type === type).length;
    const ends = inside.filter((event): event is Of<'tool.end'> => event.type === 'tool.end');
    const failed = ends.filter((event) => event.status === 'error').length;
    const denied = ends.filter((event) => event.status === 'denied').length;
    const backs = inside.filter(
      (event) => event.type === 'hook' && event.hook === 'beforeStop',
    ).length;
    const near = inside.find(
      (event): event is Of<'limit.near'> => event.type === 'limit.near' && !event.parentAgentId,
    );
    const facts = [
      run.end ? run.end.stopReason : 'did not finish',
      run.end && `${run.end.turns} turns`,
      run.end?.costUsd !== undefined && money(run.end.costUsd),
      run.end && duration(run.end.timestamp - run.start.timestamp),
      plural(ends.length, 'call') +
        (failed || denied
          ? ` (${[failed && `${failed} failed`, denied && `${denied} denied`].filter(Boolean).join(', ')})`
          : ''),
      count('subagent.start') && `${count('subagent.start')} sub-agents`,
      backs && `sent back ${backs}×`,
      count('stuck') && `going in circles ${count('stuck')}×`,
      near && `near its ${near.limit} limit`,
    ].filter(Boolean);
    return `${run.number}. ${clock(run.start.timestamp)} "${short(inputOf(run.start.input), 300)}"\n   → ${facts.join(' · ')}`;
  });
  return `## Runs (what the user asked, and how it went)\n${lines.join('\n')}`;
}

/** Denials with the user's feedback, and messages after the first: where the user corrected. */
function userCorrections(
  runs: Run[],
  events: EngineEvent[],
  calls: Map<string, Call>,
): string | undefined {
  const denied = events.filter(
    (event): event is Of<'tool.end'> => event.type === 'tool.end' && event.status === 'denied',
  );
  if (!denied.length) return undefined;
  const lines = grouped(
    denied.map((event) => ({
      key: `${labelOf(calls, event)}\u0000${event.output}`,
      text: `[${agentOf(event)}] ${labelOf(calls, event)}: ${short(event.output.replace(/^Permission denied: /, 'rule: '), 240)}`,
    })),
  );
  return `## Denied (${denied.length})\n${lines.join('\n')}`;
}

function failedCalls(events: EngineEvent[], calls: Map<string, Call>): string | undefined {
  const failed = events.filter(
    (event): event is Of<'tool.end'> => event.type === 'tool.end' && event.status === 'error',
  );
  if (!failed.length) return undefined;
  const groups = new Map<
    string,
    {
      label: string;
      count: number;
      outputs: Map<string, number>;
      last: string;
      agents: Set<string>;
    }
  >();
  for (const event of failed) {
    const label = labelOf(calls, event);
    // Commands by the command; other tools by what went wrong.
    const key =
      event.tool === 'run_command' ? label : `${event.tool}\u0000${failureLine(event.output)}`;
    const group = groups.get(key) ?? {
      label: event.tool === 'run_command' ? label : event.tool,
      count: 0,
      outputs: new Map(),
      last: '',
      agents: new Set(),
    };
    group.count += 1;
    const output = failureKey(withoutNotes(event.output));
    group.outputs.set(output, (group.outputs.get(output) ?? 0) + 1);
    group.last = failureLine(event.output);
    group.agents.add(agentOf(event));
    groups.set(key, group);
  }
  const lines = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_ITEMS)
    .map((group) => {
      const same = Math.max(...group.outputs.values());
      const repeat = same > 1 ? `, ${same}× with the same output` : '';
      return `- ${group.label} ×${group.count}${repeat} [${[...group.agents].join(', ')}]: ${group.last}`;
    });
  return `## Failed calls (${failed.length})\n${lines.join('\n')}${more(groups.size)}`;
}

function repeatedApprovals(events: EngineEvent[]): string | undefined {
  const requests = events.filter(
    (event): event is Of<'approval.request'> => event.type === 'approval.request',
  );
  if (!requests.length) return undefined;
  const answers = new Map(
    events.flatMap((event) =>
      event.type === 'approval.response' ? [[event.requestId, event.decision] as const] : [],
    ),
  );
  const groups = new Map<string, { count: number; answers: Map<string, number> }>();
  for (const request of requests) {
    const subject = request.subject ?? '';
    const key =
      `${request.tool} ${request.tool === 'run_command' ? subject.split(/\s+/).slice(0, 3).join(' ') : subject}`.trim();
    const group = groups.get(key) ?? { count: 0, answers: new Map() };
    group.count += 1;
    const decision = answers.get(request.requestId);
    const answer = !decision
      ? 'unanswered'
      : decision.allow
        ? decision.scope === 'session'
          ? 'yes for the session'
          : 'yes'
        : 'no';
    group.answers.set(answer, (group.answers.get(answer) ?? 0) + 1);
    groups.set(key, group);
  }
  const lines = [...groups.entries()]
    .filter(([, group]) => group.count > 1)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, MAX_ITEMS)
    .map(
      ([key, group]) =>
        `- ${key}… asked ${group.count}× (${[...group.answers].map(([answer, n]) => `${answer} ${n}`).join(', ')})`,
    );
  return `## Approvals: ${requests.length} asked${lines.length ? ', these again and again' : ''}\n${lines.join('\n')}`.trimEnd();
}

function sentBack(events: EngineEvent[], runs: Run[]): string | undefined {
  const hooks = events.filter(
    (event): event is Of<'hook'> => event.type === 'hook' && event.hook === 'beforeStop',
  );
  const stuck = runs.filter((run) => run.end?.stopReason === 'check_failed').length;
  if (!hooks.length && !stuck) return undefined;
  const lines = grouped(
    hooks.map((event) => {
      const kind = event.builtIn
        ? event.message.startsWith('You changed')
          ? 'changes nothing had checked'
          : 'plan steps still open'
        : `check: ${short(event.message.split('\n').find((line) => line.trim()) ?? '', 160)}`;
      return {
        key: event.builtIn ? kind : failureKey(event.message),
        text: `[${agentOf(event)}] ${kind}`,
      };
    }),
  );
  const ended = stuck
    ? `\n${stuck} run${stuck === 1 ? '' : 's'} ended because the same check kept failing (check_failed).`
    : '';
  return `## Sent back before finishing (${hooks.length})\n${lines.join('\n')}${ended}`;
}

function steppedIn(events: EngineEvent[]): string | undefined {
  const lines = events.flatMap((event) => {
    if (event.type === 'stuck') {
      return [
        `- [${agentOf(event)}] going in circles: ${short(event.subject, 120)} (${event.signal === 'same-failure' ? `failed the same way ${event.count}×` : `back to earlier content ${event.count}×`})`,
      ];
    }
    if (event.type === 'limit.near') {
      return [
        `- [${agentOf(event)}] near its ${event.limit} limit: ${Math.round((100 * event.used) / event.max)}%`,
      ];
    }
    if (event.type === 'compaction') {
      return [
        `- [${agentOf(event)}] context compacted (${event.trigger}, ${event.method}): ${tokens(event.beforeTokens)} → ${tokens(event.afterTokens)} tokens`,
      ];
    }
    if (
      event.type === 'tool.end' &&
      event.tool === 'delegate' &&
      event.output.startsWith('Not started')
    ) {
      return [`- [${agentOf(event)}] a sub-agent was not started: too little budget left`];
    }
    return [];
  });
  if (!lines.length) return undefined;
  return `## heaw stepped in\n${lines.slice(0, MAX_ITEMS * 2).join('\n')}${lines.length > MAX_ITEMS * 2 ? `\n- … and ${lines.length - MAX_ITEMS * 2} more` : ''}`;
}

/** Per agent: another agent reading the same file is no repeat, it has its own context. */
function repeatedCalls(events: EngineEvent[]): string | undefined {
  const counts = new Map<string, { label: string; count: number }>();
  for (const event of events) {
    if (event.type !== 'tool.start') continue;
    const key = `${event.agentId}\u0000${event.tool}\u0000${JSON.stringify(event.args) ?? ''}`;
    const entry = counts.get(key) ?? {
      label: `[${event.agentId}] ${label(event.tool, event.args)}`,
      count: 0,
    };
    entry.count += 1;
    counts.set(key, entry);
  }
  const repeated = [...counts.values()].filter((entry) => entry.count > 1);
  if (!repeated.length) return undefined;
  const extra = sum(repeated.map((entry) => entry.count - 1));
  const lines = repeated
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_ITEMS)
    .map((entry) => `- ${entry.label} ×${entry.count}`);
  return `## Calls repeated with the same arguments (${extra} repeats)\n${lines.join('\n')}`;
}

/** File changes one per model call: every call re-sends the whole context. */
function oneChangePerResponse(events: EngineEvent[]): string | undefined {
  const turns = new Map<string, string[]>();
  const turnOf = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'turn.start') turnOf.set(event.agentId, event.turn);
    if (event.type !== 'tool.start') continue;
    const turn = `${event.agentId}:${turnOf.get(event.agentId) ?? 0}`;
    turns.set(turn, [...(turns.get(turn) ?? []), event.tool]);
  }
  const changes = sum(
    [...turns.values()].map((tools) => tools.filter((tool) => WRITE_TOOLS.has(tool)).length),
  );
  const alone = [...turns.values()].filter(
    (tools) => tools.length === 1 && WRITE_TOOLS.has(tools[0]!),
  ).length;
  if (changes < 6 || alone / changes < 0.5) return undefined;
  return (
    `## One change per response\n${alone} of ${changes} file changes were the only call in their ` +
    'model response; independent changes can go in one response (and several edits of one file ' +
    'in one edit_file call), saving a full model call each.'
  );
}

function subagents(events: EngineEvent[]): string | undefined {
  const starts = events.filter(
    (event): event is Of<'subagent.start'> => event.type === 'subagent.start',
  );
  if (!starts.length) return undefined;
  const ends = new Map(
    events.flatMap((event) =>
      event.type === 'subagent.end' ? [[event.childAgentId, event] as const] : [],
    ),
  );
  const rows = starts.map((start) => {
    const end = ends.get(start.childAgentId);
    const own = events.filter(
      (event): event is Of<'tool.end'> =>
        event.type === 'tool.end' && event.agentId === start.childAgentId,
    );
    const failed = own.filter((event) => event.status !== 'ok').length;
    const how = !end
      ? 'did not finish'
      : end.stopReason === 'end_turn'
        ? 'finished'
        : `stopped early: ${end.stopReason}`;
    const facts = [
      how,
      end && `${end.turns} turns`,
      end?.costUsd !== undefined && money(end.costUsd),
      end && duration(end.timestamp - start.timestamp),
      `${plural(own.length, 'call')}${failed ? ` (${failed} not ok)` : ''}`,
    ].filter(Boolean);
    return {
      cost: end?.costUsd ?? 0,
      text: `- ${start.childAgentId}: "${short(start.task, 140)}" → ${facts.join(' · ')}`,
    };
  });
  const shown =
    rows.length > MAX_ITEMS * 2
      ? [...rows].sort((a, b) => b.cost - a.cost).slice(0, MAX_ITEMS * 2)
      : rows;
  const total = sum(rows.map((row) => row.cost));
  return `## Sub-agents (${starts.length}${total ? `, ${money(total)}` : ''})\n${shown.map((row) => row.text).join('\n')}${rows.length > shown.length ? `\n- … and ${rows.length - shown.length} cheaper ones` : ''}`;
}

/** What the main agent's tool results added to its context, which every later call re-sends. */
function contextFillers(events: EngineEvent[], calls: Map<string, Call>): string | undefined {
  const ends = events.filter((event): event is Of<'tool.end'> => event.type === 'tool.end');
  if (!ends.length) return undefined;
  const byTool = new Map<string, { chars: number; calls: number }>();
  for (const event of ends.filter((end) => !end.parentAgentId)) {
    const entry = byTool.get(event.tool) ?? { chars: 0, calls: 0 };
    entry.chars += event.output.length;
    entry.calls += 1;
    byTool.set(event.tool, entry);
  }
  const tools = [...byTool.entries()]
    .sort((a, b) => b[1].chars - a[1].chars)
    .slice(0, 5)
    .map(([tool, entry]) => `${tool} ${chars(entry.chars)} (${plural(entry.calls, 'call')})`);
  const largest = [...ends]
    .sort((a, b) => b.output.length - a.output.length)
    .slice(0, 5)
    .map(
      (event) => `- [${agentOf(event)}] ${labelOf(calls, event)}: ${chars(event.output.length)}`,
    );
  return `## What fills the context\nMain agent's tool results: ${tools.join(', ') || 'none'}.\nLargest results:\n${largest.join('\n')}`;
}

function filesChanged(events: EngineEvent[]): string | undefined {
  // Only changes that were made, not denied or failed attempts.
  const made = new Set(
    events.flatMap((event) =>
      event.type === 'tool.end' && event.status === 'ok'
        ? [`${event.agentId}:${event.callId}`]
        : [],
    ),
  );
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'tool.start' || !WRITE_TOOLS.has(event.tool)) continue;
    if (!made.has(`${event.agentId}:${event.callId}`)) continue;
    const path = (event.args as { path?: unknown } | undefined)?.path;
    if (typeof path === 'string') counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  if (!counts.size) return undefined;
  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ITEMS)
    .map(([path, count]) => `${path} ×${count}`);
  return `## Files changed most (${plural(counts.size, 'file')})\n${lines.join(', ')}`;
}

function errors(events: EngineEvent[]): string | undefined {
  const lines = grouped(
    events.flatMap((event) =>
      event.type === 'error'
        ? [
            {
              key: `${event.error.name}${event.error.message.slice(0, 120)}`,
              text: `${event.recoverable ? '' : 'run ended: '}${event.error.name}: ${short(event.error.message, 200)}`,
            },
          ]
        : [],
    ),
  );
  return lines.length ? `## Errors\n${lines.join('\n')}` : undefined;
}

function links(events: EngineEvent[]): string | undefined {
  const lines = events.flatMap((event) =>
    event.type === 'link'
      ? [
          `- ${event.kind === 'commit' ? `commit ${event.ref.slice(0, 7)} ${event.title ?? ''}`.trimEnd() : `pull request ${event.ref}`}`,
        ]
      : [],
  );
  return lines.length ? `## Commits and pull requests\n${lines.join('\n')}` : undefined;
}

function otherSessions(others: SessionSummary[]): string {
  if (!others.length) return '';
  const lines = others.map(
    (summary) =>
      `- ${summary.id}: ${summary.runs} run${summary.runs === 1 ? '' : 's'}${summary.costUsd !== undefined ? `, ${money(summary.costUsd)}` : ''}, "${short(summary.title, 80)}"`,
  );
  return `\n\nOther sessions:\n${lines.join('\n')}`;
}

/** One run step by step: calls (with failures), answers, what heaw did, the agent's words. */
export function runSteps(records: SessionRecord[], number: number): string {
  const runs = runsOf(records);
  const run = runs[number - 1];
  if (!run) return `There is no run ${number}; this session has ${runs.length}.`;
  const turnOf = new Map<string, number>();
  const lines: string[] = [];
  for (const record of records.slice(run.from, run.to + 1)) {
    if (record.type === 'message' && record.message.role === 'assistant') {
      const text = textOf(record.message).trim();
      if (text) lines.push(`[main] says: ${short(text, 300)}`);
      continue;
    }
    if (record.type !== 'event') continue;
    const step = steps(record.event, agentOf(record.event), turnOf);
    if (step) lines.push(step);
  }
  const shown =
    lines.length > MAX_STEPS
      ? [
          ...lines.slice(0, 150),
          `… ${lines.length - MAX_STEPS} steps left out …`,
          ...lines.slice(-(MAX_STEPS - 150)),
        ]
      : lines;
  return `# Run ${number} of ${runs.length}, step by step\n${shown.join('\n')}`;
}

function steps(event: EngineEvent, who: string, turnOf: Map<string, number>): string | undefined {
  switch (event.type) {
    case 'run.start':
      return event.parentAgentId
        ? undefined
        : `${clock(event.timestamp)} the user: "${short(inputOf(event.input), 600)}"`;
    case 'turn.start':
      turnOf.set(event.agentId, event.turn);
      return undefined;
    case 'tool.start':
      return `[${who} t${turnOf.get(event.agentId) ?? 0}] ${label(event.tool, event.args)}`;
    case 'tool.end':
      if (event.status === 'ok') return undefined;
      return `   → ${event.status}: ${event.status === 'error' ? failureLine(event.output) : short(event.output, 240)}`;
    case 'approval.response':
      return `   → the user: ${event.decision.allow ? (event.decision.scope === 'session' ? 'yes for the session' : 'yes') : `no${event.decision.feedback ? `: "${short(event.decision.feedback, 200)}"` : ''}`}`;
    case 'hook':
      return `heaw → [${who}] ${event.builtIn ? 'sent back' : `${event.hook} hook`}: ${short(event.message, 240)}`;
    case 'stuck':
      return `heaw → [${who}] going in circles: ${short(event.subject, 120)} (${event.count}×)`;
    case 'limit.near':
      return `heaw → [${who}] near its ${event.limit} limit (${Math.round((100 * event.used) / event.max)}%)`;
    case 'compaction':
      return `heaw → [${who}] context compacted: ${tokens(event.beforeTokens)} → ${tokens(event.afterTokens)} tokens`;
    case 'subagent.start':
      return `[${event.childAgentId}] started: "${short(event.task, 300)}"`;
    case 'subagent.end':
      return `[${event.childAgentId}] ${event.stopReason === 'end_turn' ? 'finished' : `stopped: ${event.stopReason}`} · ${event.turns} turns${event.costUsd !== undefined ? ` · ${money(event.costUsd)}` : ''}`;
    case 'error':
      return `error [${who}]: ${short(event.error.message, 240)}`;
    case 'run.end':
      return event.parentAgentId
        ? undefined
        : `${clock(event.timestamp)} run ended: ${event.stopReason} · ${event.turns} turns${event.costUsd !== undefined ? ` · ${money(event.costUsd)}` : ''}`;
    default:
      return undefined;
  }
}

// --- Reading the log ---

interface Call {
  tool: string;
  args: unknown;
}

function eventsOf(records: SessionRecord[]): EngineEvent[] {
  return records.flatMap((record) => (record.type === 'event' ? [record.event] : []));
}

/** The user's runs: sub-agents' runs are part of them. */
function runsOf(records: SessionRecord[]): Run[] {
  const runs: Run[] = [];
  for (const [index, record] of records.entries()) {
    if (record.type !== 'event' || record.event.parentAgentId) continue;
    const event = record.event;
    if (event.type === 'run.start') {
      runs.push({
        number: runs.length + 1,
        start: event,
        end: undefined,
        from: index,
        to: records.length - 1,
      });
    } else if (event.type === 'run.end') {
      const run = runs.at(-1);
      if (run && !run.end) {
        run.end = event;
        run.to = index;
      }
    }
  }
  return runs;
}

function callsOf(events: EngineEvent[]): Map<string, Call> {
  const calls = new Map<string, Call>();
  for (const event of events) {
    if (event.type === 'tool.start')
      calls.set(`${event.agentId}:${event.callId}`, { tool: event.tool, args: event.args });
  }
  return calls;
}

function labelOf(calls: Map<string, Call>, event: Of<'tool.end'>): string {
  const call = calls.get(`${event.agentId}:${event.callId}`);
  return call ? label(call.tool, call.args) : event.tool;
}

function agentOf(event: EngineEvent): string {
  return event.agentId;
}

/** `run_command npm test`, `edit_file src/a.ts`: the tool and its most telling argument. */
function label(tool: string, args: unknown): string {
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? record[key] : undefined);
  if (tool === 'delegate')
    return `delegate ${text('agent') ?? 'agent'}: ${short(text('task') ?? '', 80)}`;
  const detail = ['command', 'path', 'pattern', 'url', 'name'].map(text).find(Boolean);
  return detail === undefined ? tool : `${tool} ${short(detail, 120)}`;
}

/** The run's input without the notes heaw put before it (`[…]` paragraphs). */
function inputOf(input: string): string {
  const parts = input.split('\n\n');
  while (parts.length > 1 && /^\[[\s\S]*\]$/.test(parts[0]!.trim())) parts.shift();
  return parts.join('\n\n');
}

/** A result without the notes heaw added to it (going in circles, near a limit). */
function withoutNotes(output: string): string {
  return output
    .split('\n')
    .filter((line) => !line.trim().startsWith('[heaw:'))
    .join('\n');
}

/** The line that says why a call failed: the status, and the first line that names an error. */
function failureLine(output: string): string {
  const lines = withoutNotes(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const status = /^\[(exit code [^\]]+|Stopped:[^\]]*)\]$/.exec(lines.at(-1) ?? '')?.[1];
  const body = status ? lines.slice(0, -1) : lines;
  const telling =
    body.find((line) => /error|fail|cannot|can't|not found|expected|denied|✗|×/i.test(line)) ??
    body.at(-1) ??
    '';
  return short(status ? `${status}: ${telling}` : telling, 200);
}

function grouped(items: Array<{ key: string; text: string }>): string[] {
  const groups = new Map<string, { text: string; count: number }>();
  for (const item of items) {
    const group = groups.get(item.key) ?? { text: item.text, count: 0 };
    group.count += 1;
    groups.set(item.key, group);
  }
  const lines = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_ITEMS)
    .map((group) => `- ${group.text}${group.count > 1 ? ` (×${group.count})` : ''}`);
  return groups.size > MAX_ITEMS ? [...lines, `- … and ${groups.size - MAX_ITEMS} more`] : lines;
}

function more(total: number): string {
  return total > MAX_ITEMS ? `\n- … and ${total - MAX_ITEMS} more` : '';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function short(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function tokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function chars(count: number): string {
  return count < 1_000 ? `${count} chars` : `${Math.round(count / 1_000)}k chars`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1_000)} s`;
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function clock(timestamp: number, withDate = false): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withDate
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
    : time;
}

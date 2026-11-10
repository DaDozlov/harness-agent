import { randomUUID } from 'node:crypto';
import type { FileChanges } from './changes.js';
import { isAbortError } from './errors.js';
import type { ApprovalDecision, ApprovalRequest, EngineEvent, EngineEventBody } from './events.js';
import { type HookContext, type HookFailure, hookFailureEvent, type HookRunner } from './hooks.js';
import type { ToolCallPart, ToolImage, ToolResultPart } from './messages.js';
import { type PermissionPolicy, type Subject, suggestRule } from './permissions.js';
import { EventQueue } from './event-queue.js';
import { type LoopDetector, type StuckSignal, stuckNote } from './stuck.js';
import {
  type AgentContext,
  concurrencyOf,
  type Tool,
  type ToolOutput,
  type ToolStatus,
} from './tools.js';
import { truncateMiddle } from './truncate.js';
import type { Workspace } from './workspace.js';

export type { ApprovalRequest } from './events.js';

export interface ToolRuntime {
  /** The tools available right now. */
  tools: () => ReadonlyMap<string, Tool>;
  permissions: PermissionPolicy;
  workspace: Workspace;
  /** `false`: nobody can answer approval requests, so `ask` becomes `deny`. */
  interactive: boolean;
  /** Resolves when the consumer answers the request (see `Session.approve`). */
  requestApproval: RequestApproval;
  state: Map<string, unknown>;
  maxOutputChars: number;
  /** Workspace-relative folder for full outputs that were truncated. */
  outputDir: string;
  /** Notes what file tools change, so a run can be rewound. */
  changes?: FileChanges | undefined;
  /** Notices the agent going in circles; reset per run. */
  loops?: LoopDetector | undefined;
  /** After a tool wrote a file: a note for the model about it, if any (e.g. plan steps lost). */
  afterWrite?: ((path: string) => Promise<string | undefined>) | undefined;
  /** `beforeToolCall` and `afterToolCall` hooks, with the context they receive. */
  hooks?: { runner: HookRunner; context: (signal: AbortSignal) => HookContext } | undefined;
  /** The agent running the tools, for tools that start sub-agents; `record` saves their events. */
  agent?:
    | (Omit<AgentContext, 'emit' | 'remaining'> & { record: (event: EngineEvent) => void })
    | undefined;
}

/** What the current run may still spend, for sub-agents' budgets. */
export type Remaining = () => { tokens?: number; costUsd?: number };

/**
 * Waits for the user's answer. `allowedNow` tells whether the call no longer needs asking, e.g.
 * because the user allowed a waiting request "for the session" and that covers this one too.
 */
export type RequestApproval = (
  request: ApprovalRequest,
  signal: AbortSignal,
  allowedNow?: () => boolean,
) => Promise<ApprovalDecision>;

type Stamp = (body: EngineEventBody) => EngineEvent;

interface Approved {
  call: ToolCallPart;
  tool: Tool;
  args: unknown;
  subject: Subject | undefined;
}

interface Finished {
  output: string;
  /** For the model only; events and saved sessions keep the description in `output`. */
  images?: ToolImage[] | undefined;
  status: ToolStatus;
  durationMs: number;
  /** `afterToolCall` hooks that threw. */
  failures?: HookFailure[];
  /** The file it wrote went back to earlier content again. */
  stuck?: StuckSignal | undefined;
}

/**
 * Executes the tool calls of one model turn (docs/DESIGN.md §4.1). Every call gets a result,
 * even when denied or cancelled: providers reject a history with unanswered tool calls.
 */
export async function* executeToolCalls(
  calls: ToolCallPart[],
  runtime: ToolRuntime,
  stamp: Stamp,
  signal: AbortSignal,
  remaining: Remaining = () => ({}),
): AsyncGenerator<EngineEvent, ToolResultPart[]> {
  const results = new Map<string, ToolResultPart>();
  function* finish(call: ToolCallPart, result: Finished): Generator<EngineEvent> {
    // Going in circles: the agent is told on this result, the user with an event.
    const stuck =
      result.stuck ??
      runtime.loops?.finished({
        tool: call.name,
        args: call.args,
        output: result.output,
        status: result.status,
      });
    const output = stuck ? `${result.output}\n\n[${stuckNote(stuck)}]` : result.output;
    results.set(call.id, {
      type: 'tool-result',
      callId: call.id,
      name: call.name,
      output,
      ...(result.status !== 'ok' && { isError: true }),
      ...(result.images?.length && { images: result.images }),
    });
    yield stamp({
      type: 'tool.end',
      callId: call.id,
      tool: call.name,
      output,
      status: result.status,
      isError: result.status !== 'ok',
      durationMs: result.durationMs,
    });
    if (stuck) yield stamp({ type: 'stuck', ...stuck });
  }

  // Phase 1, in the model's order: validate and check permissions, asking where needed.
  const approved: Approved[] = [];
  for (const call of calls) {
    yield stamp({ type: 'tool.start', callId: call.id, tool: call.name, args: call.args });
    const outcome = yield* authorize(call, runtime, stamp, signal);
    if ('finished' in outcome) yield* finish(call, outcome.finished);
    else approved.push(outcome);
  }

  // Phase 2: run. Consecutive parallel-safe calls run together; the rest one at a time, in order.
  for (const batch of batches(approved)) {
    const outcomes = signal.aborted
      ? batch.map(cancelled)
      : yield* runBatch(batch, runtime, signal, remaining);
    for (const [index, outcome] of outcomes.entries()) {
      const { call } = batch[index]!;
      yield* finish(call, outcome);
      if (outcome.status === 'ok')
        for (const url of pullRequestsIn(call, outcome.output)) {
          yield stamp({ type: 'link', kind: 'pull_request', ref: url });
        }
      for (const failure of outcome.failures ?? []) yield stamp(hookFailureEvent(failure));
    }
  }

  return calls.map((call) => results.get(call.id)!);
}

/** Runs calls together. Tools can report as they go (a sub-agent's activity), passed on live. */
async function* runBatch(
  batch: Approved[],
  runtime: ToolRuntime,
  signal: AbortSignal,
  remaining: Remaining,
): AsyncGenerator<EngineEvent, Finished[]> {
  const side = new EventQueue<EngineEvent>();
  const together = (item: Approved) =>
    batch.filter((other) => other.tool.name === item.tool.name).length;
  const running = Promise.all(
    batch.map((item) => run(item, runtime, signal, side, remaining, together(item))),
  ).finally(() => side.close());
  for await (const event of side) yield event;
  return running;
}

/** Decides whether a call may run: known tool, valid arguments, permission (maybe asking). */
async function* authorize(
  call: ToolCallPart,
  runtime: ToolRuntime,
  stamp: Stamp,
  signal: AbortSignal,
): AsyncGenerator<EngineEvent, Approved | { finished: Finished }> {
  if (signal.aborted) return { finished: cancelled() };

  const tools = runtime.tools();
  const tool = tools.get(call.name);
  if (!tool) {
    const available = [...tools.keys()].join(', ') || 'none';
    const hint = tools.has('load_tools')
      ? ' A tool listed under "MCP tools on demand" has to be loaded with load_tools first.'
      : '';
    return {
      finished: error(`Unknown tool "${call.name}". Available tools: ${available}.${hint}`),
    };
  }

  const parsed = tool.parse(call.args);
  if (!parsed.ok)
    return { finished: error(`Invalid arguments for ${tool.name}:\n${parsed.error}`) };
  const hooked = await beforeToolCall(call, tool, parsed.args, runtime, signal);
  if ('finished' in hooked) return hooked;
  const { args, allowedByHook } = hooked;

  // A call that would fail anyway is not put to the user.
  const problem = await tool
    .precheck?.(args, { workspace: runtime.workspace, agent: runtime.agent })
    .catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
  if (problem) return { finished: error(problem) };

  // Permissions see the arguments as the hooks left them.
  const subject = subjectOf(tool, args, runtime.workspace);
  const approved: Approved = { call, tool, args, subject };
  const check = runtime.permissions.check(tool, subject);
  // A hook may answer for the user, but not override a deny rule.
  const allowed = check.decision === 'allow' || (check.decision === 'ask' && allowedByHook);
  if (allowed) return approved;
  if (check.decision === 'deny') return { finished: denied(`Permission denied: ${check.reason}.`) };

  if (!runtime.interactive) {
    return { finished: denied(nonInteractiveDenial(tool, subject, check.reason, runtime)) };
  }

  const request: ApprovalRequest = {
    requestId: randomUUID(),
    callId: call.id,
    tool: tool.name,
    args,
    subject: subject?.value,
    reason: check.reason,
    forSession: runtime.permissions.describeSessionGrant(tool, subject),
  };
  // Register the request before announcing it: a consumer may answer as soon as it sees the event.
  const answer = runtime.requestApproval(
    request,
    signal,
    () => runtime.permissions.check(tool, subject).decision === 'allow',
  );
  answer.catch(() => undefined); // Rejections (abort) are handled when awaited below.
  yield stamp({ type: 'approval.request', ...request });
  let decision: ApprovalDecision;
  try {
    decision = await answer;
  } catch (cause) {
    if (signal.aborted || isAbortError(cause)) return { finished: cancelled() };
    throw cause;
  }
  // Granted before the response is announced, so requests still waiting can be checked again.
  if (decision.allow && decision.scope === 'session') {
    runtime.permissions.approveForSession(tool, subject);
  }
  yield stamp({ type: 'approval.response', requestId: request.requestId, decision });

  if (!decision.allow) {
    const feedback = decision.feedback ? ` Their feedback: ${decision.feedback}` : '';
    return { finished: denied(`The user denied this action.${feedback}`) };
  }
  return approved;
}

/** Tells the model what it may do instead, so it can adjust rather than give up. */
function nonInteractiveDenial(
  tool: Tool,
  subject: Subject | undefined,
  reason: string,
  runtime: ToolRuntime,
): string {
  const rule = suggestRule(tool.name, subject);
  const allowed = runtime.permissions.allowRulesFor(tool.name);
  const alternatives = allowed.length
    ? ` These ${tool.name} calls are allowed in this run: ${allowed.join(', ')}.`
    : '';
  return (
    `Permission denied: this action needs approval because ${reason}, and this run ` +
    `cannot ask the user.${alternatives} To allow this exact call, the user can run ` +
    `again with the rule "${rule}".`
  );
}

/** Lets `beforeToolCall` hooks block the call, change its arguments or allow it. */
async function beforeToolCall(
  call: ToolCallPart,
  tool: Tool,
  args: unknown,
  runtime: ToolRuntime,
  signal: AbortSignal,
): Promise<{ args: unknown; allowedByHook: boolean } | { finished: Finished }> {
  const hooks = runtime.hooks;
  if (!hooks?.runner.has('beforeToolCall')) return { args, allowedByHook: false };
  const verdict = await hooks.runner.beforeToolCall(
    hooks.context(signal),
    tool.name,
    args,
    call.id,
  );
  if ('block' in verdict) return { finished: denied(`Blocked by a hook: ${verdict.block}`) };
  if (verdict.args === args) return { args, allowedByHook: verdict.allow };
  const changed = tool.parse(verdict.args);
  if (!changed.ok) {
    return {
      finished: error(
        `A beforeToolCall hook gave invalid arguments for ${tool.name}:\n${changed.error}`,
      ),
    };
  }
  return { args: changed.args, allowedByHook: verdict.allow };
}

async function run(
  item: Approved,
  runtime: ToolRuntime,
  signal: AbortSignal,
  side: EventQueue<EngineEvent>,
  remaining: Remaining,
  together: number,
): Promise<Finished> {
  const started = Date.now();
  const host = runtime.agent;
  const agent: AgentContext | undefined = host && {
    ...host,
    remaining,
    emit: (event) => {
      host.record(event);
      side.push(event);
    },
  };
  const path = writtenPath(item);
  try {
    if (path) {
      await runtime.changes?.before(path).catch(() => undefined);
      await runtime.loops?.before(path).catch(() => undefined);
    }
    const raw: ToolOutput = await item.tool.run(item.args, {
      workspace: runtime.workspace,
      signal,
      callId: item.call.id,
      together,
      state: runtime.state,
      agent,
    });
    const { output, isError, images } =
      typeof raw === 'string' ? { output: raw, isError: false, images: undefined } : raw;
    const status: ToolStatus = isError ? 'error' : 'ok';
    const wrote = path && !isError ? path : undefined;
    if (wrote) runtime.changes?.after(wrote);
    const stuck = wrote ? await runtime.loops?.written(wrote).catch(() => undefined) : undefined;
    const note = wrote ? await runtime.afterWrite?.(wrote).catch(() => undefined) : undefined;
    const limited = (await limitOutput(output, item, runtime)) + (note ? `\n\n[${note}]` : '');
    const durationMs = Date.now() - started;
    const hooks = runtime.hooks;
    if (!hooks?.runner.has('afterToolCall')) {
      return { output: limited, images, status, durationMs, stuck };
    }
    const after = await hooks.runner.afterToolCall(hooks.context(signal), {
      tool: item.tool.name,
      args: item.args,
      output: limited,
      status,
    });
    return {
      output: after.feedback ? `${limited}\n\n${after.feedback}` : limited,
      images,
      status,
      durationMs,
      failures: after.failures,
      stuck,
    };
  } catch (cause) {
    const durationMs = Date.now() - started;
    if (signal.aborted || isAbortError(cause)) return { ...cancelled(), durationMs };
    const message = cause instanceof Error ? cause.message : String(cause);
    return { output: `Error: ${message}`, status: 'error', durationMs };
  }
}

const PULL_REQUEST_URL = /https:\/\/[^\s"'<>()]+\/(?:pull|-\/merge_requests)\/\d+/g;
/** A tool, or a command line, that opens pull requests (GitHub) or merge requests (GitLab). */
const CREATES_PULL_REQUESTS = /create_(?:pull|merge)_request/i;
const CREATE_COMMANDS = /\b(?:gh\s+pr\s+create|glab\s+mr\s+create)\b/;

/** Pull requests a call opened, so the session can be linked to them. */
function pullRequestsIn(call: ToolCallPart, output: string): string[] {
  const command = (call.args as { command?: unknown } | undefined)?.command;
  const creates =
    CREATES_PULL_REQUESTS.test(call.name) ||
    (typeof command === 'string' && CREATE_COMMANDS.test(command));
  return creates ? [...new Set(output.match(PULL_REQUEST_URL) ?? [])] : [];
}

/** The file a write tool is about to change. */
function writtenPath(item: Approved): string | undefined {
  return item.tool.kind === 'write' && item.subject?.type === 'path'
    ? item.subject.value
    : undefined;
}

/**
 * Oversized output is cut; the full text is saved so the model can page through it. A tool can
 * ask for a smaller limit and for more of the end (command output ends with what matters).
 */
async function limitOutput(output: string, item: Approved, runtime: ToolRuntime): Promise<string> {
  const max = Math.min(runtime.maxOutputChars, item.tool.output?.maxChars ?? Infinity);
  if (output.length <= max) return output;
  let savedTo: string | undefined;
  try {
    savedTo = `${runtime.outputDir}/${item.call.id.replace(/[^\w-]/g, '_')}.txt`;
    await runtime.workspace.writeFile(savedTo, output);
    // Keeps saved outputs out of git even in projects that never ran `heaw init`.
    await runtime.workspace.writeFile(`${runtime.outputDir}/.gitignore`, '*\n');
  } catch {
    savedTo = undefined;
  }
  return truncateMiddle(
    output,
    max,
    (omitted) =>
      savedTo
        ? `${omitted} characters omitted. The full output is in ${savedTo}; read it with read_file using offset and limit.`
        : `${omitted} characters omitted.`,
    item.tool.output?.headShare,
  ).text;
}

function subjectOf(tool: Tool, args: unknown, workspace: Workspace): Subject | undefined {
  const value = tool.subject?.(args);
  if (value === undefined) return undefined;
  if (tool.subjectType !== 'path') return { value, type: 'text' };
  // Paths are matched relative to the workspace root, with forward slashes.
  return { value: workspace.displayPath(value), type: 'path' };
}

function* batches(items: Approved[]): Generator<Approved[]> {
  let parallel: Approved[] = [];
  for (const item of items) {
    if (concurrencyOf(item.tool) === 'parallel') {
      parallel.push(item);
      continue;
    }
    if (parallel.length) yield parallel;
    parallel = [];
    yield [item];
  }
  if (parallel.length) yield parallel;
}

function cancelled(): Finished {
  return { output: 'Cancelled by the user.', status: 'cancelled', durationMs: 0 };
}

function error(output: string): Finished {
  return { output, status: 'error', durationMs: 0 };
}

function denied(output: string): Finished {
  return { output, status: 'denied', durationMs: 0 };
}

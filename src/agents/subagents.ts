import { z } from 'zod';
import type { EngineEvent, StopReason } from '../core/events.js';
import { hookFailureEvent } from '../core/hooks.js';
import type { RunLimits } from '../core/loop.js';
import { lastAnswer, type Message } from '../core/messages.js';
import {
  type PermissionPolicy,
  type PermissionRestriction,
  splitCommands,
} from '../core/permissions.js';
import type { Session } from '../core/session.js';
import type { AgentContext, Tool, ToolOutput } from '../core/tools.js';
import { addUsage, emptyUsage } from '../core/usage.js';
import { defineTool } from '../tools/define.js';
import type { AgentDefinition } from './definitions.js';

export interface SubagentSettings {
  /** How deep agents may nest: 1 means sub-agents cannot start their own. Default: 1. */
  maxDepth?: number;
  /** Sub-agents running at the same time; more wait their turn. Default: 4. */
  maxParallel?: number;
  /** Limits for each sub-agent whose definition sets none. Default: 50 turns. */
  limits?: Partial<RunLimits>;
  /**
   * `provider:model` for sub-agents whose definition names none, e.g. a cheaper one than the
   * main agent's. Default: the calling agent's model.
   */
  model?: string;
  /**
   * The least budget a sub-agent starts with: its share of what the run has left (split among
   * the sub-agents started together). Below it, it is not started. Default: $0.50, 30,000 tokens.
   */
  minBudget?: { costUsd?: number; tokens?: number };
}

export const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_LIMITS: Partial<RunLimits> = { maxTurns: 50 };
const DEFAULT_MIN_BUDGET = { costUsd: 0.5, tokens: 30_000 };

type Budget = { tokens?: number; costUsd?: number };

/** What the engine needs to build a sub-agent's session. */
export interface SubagentSpec {
  /** The definition's name, or `agent` for a general sub-agent. */
  name: string;
  agentId: string;
  parent: AgentContext;
  definition: AgentDefinition | undefined;
  /** For a general sub-agent: its role, written by the calling agent. */
  instructions: string | undefined;
  /** A subset of the parent's tools. */
  tools: Tool[];
  limits: Partial<RunLimits>;
  permissions: PermissionPolicy;
  signal: AbortSignal;
}

export type CreateSubagentSession = (spec: SubagentSpec) => Promise<Session>;

/**
 * `delegate` (docs/DESIGN.md §4.7): runs a task in a sub-agent with a fresh context and returns
 * its final report. A sub-agent never gets more than its parent: a subset of its tools, its
 * permissions (maybe stricter), its approvals channel, and what is left of its budget.
 */
export function delegateTool(options: {
  agents: readonly AgentDefinition[];
  settings: SubagentSettings;
  createSession: CreateSubagentSession;
}): Tool {
  const slots = new Slots(options.settings.maxParallel ?? DEFAULT_MAX_PARALLEL);
  let started = 0;
  const named = options.agents.length
    ? `Named agents:\n${options.agents.map((agent) => `- ${agent.name}: ${agent.description}`).join('\n')}\n`
    : '';

  return defineTool({
    name: 'delegate',
    description:
      'Hand a self-contained task to a sub-agent. It works in a fresh context with its own ' +
      'turns and tools and returns only its final report, so your context stays small. Use it ' +
      'for work that would fill your context (searching or reviewing many files) or that a ' +
      'specialist does better. Independent tasks run in parallel when you call delegate several ' +
      'times in one turn; sub-agents that change files then each need their own files, and you ' +
      'change the shared ones: give each its `files`. The sub-agent sees only `task`, not this ' +
      'conversation: include the goal, the facts it needs (interfaces, data shapes, helpers to ' +
      'reuse, with paths), constraints, and what to report; say that text users will see must ' +
      'describe the product, not this task. Give `check` when a command shows the task is done.' +
      `\n${named}` +
      'Act on what matters in a report (a review always finds something more), and do not send ' +
      'the same work back for another round over minor points. ' +
      'Without `agent`, it is a general sub-agent: describe its role in `instructions` and ' +
      'optionally limit `tools` to some of yours.',
    kind: 'read',
    concurrency: 'parallel',
    parameters: z.object({
      agent: z.string().optional().describe('A named agent from the list; omit for a general one'),
      task: z
        .string()
        .min(1)
        .describe('The complete task: goal, context, files, constraints and what to report'),
      instructions: z
        .string()
        .optional()
        .describe('For a general sub-agent: its role and how it should work'),
      tools: z
        .array(z.string())
        .optional()
        .describe('For a general sub-agent: which of your tools it may use (default: all)'),
      files: z
        .array(z.string())
        .optional()
        .describe(
          'Globs of the only files it may change, e.g. ["src/billing/**"]; its other writes are denied',
        ),
      check: z
        .string()
        .optional()
        .describe(
          'A command that shows the task is done, e.g. the tests of its files. A sub-agent that ' +
            'can run commands must make it pass before it reports; otherwise you run it after.',
        ),
    }),
    // Rules can allow or deny agents by name: delegate(reviewer).
    subject: (args) => args.agent ?? 'agent',
    async run(args, context) {
      const parent = context.agent;
      if (!parent) return { output: 'delegate only works inside an agent session.', isError: true };
      const definition = args.agent
        ? options.agents.find((agent) => agent.name === args.agent)
        : undefined;
      if (args.agent && !definition) {
        const names = options.agents.map((agent) => agent.name).join(', ') || 'none';
        return {
          output: `There is no agent named "${args.agent}". Named agents: ${names}. Omit agent for a general sub-agent.`,
          isError: true,
        };
      }
      // Sub-agents started together share what is left, instead of each getting all of it and
      // all of them stopping at the limit at once.
      const share = shareOf(parent.remaining(), context.together ?? 1);
      const short = tooLittle(share, parent.remaining(), context.together ?? 1, options.settings);
      if (short) return { output: short, isError: true };
      await slots.acquire(context.signal);
      try {
        return await runSubagent({
          parent,
          definition,
          task: args.task,
          instructions: args.instructions,
          toolNames: args.tools,
          files: args.files,
          check: args.check,
          budget: share,
          agentId: `${definition?.name ?? 'agent'}-${++started}`,
          callId: context.callId,
          settings: options.settings,
          createSession: options.createSession,
          signal: context.signal,
        });
      } finally {
        slots.release();
      }
    },
  });
}

async function runSubagent(run: {
  parent: AgentContext;
  definition: AgentDefinition | undefined;
  task: string;
  instructions: string | undefined;
  toolNames: string[] | undefined;
  /** Globs of the only files it may change. */
  files: string[] | undefined;
  /** A command that shows its task is done. */
  check: string | undefined;
  /** Its share of what the parent's run has left. */
  budget: Budget;
  agentId: string;
  /** The delegate call that starts it. */
  callId: string;
  settings: SubagentSettings;
  createSession: CreateSubagentSession;
  signal: AbortSignal;
}): Promise<ToolOutput> {
  const { parent, definition, signal, check } = run;
  const name = definition?.name ?? 'agent';
  const hookContext = parent.hookContext(signal);
  const report = (event: EngineEvent) => parent.emit(event);

  const maxDepth = run.settings.maxDepth ?? DEFAULT_MAX_DEPTH;
  const wanted = definition?.tools ?? run.toolNames;
  const tools = parent
    .tools()
    .filter((tool) => !wanted || wanted.includes(tool.name))
    // Nesting stops at the depth limit.
    .filter((tool) => tool.name !== 'delegate' || parent.depth + 1 < maxDepth)
    // Plan mode belongs to the user's agent.
    .filter((tool) => tool.name !== 'start_plan' && tool.name !== 'finish_plan');
  const canRun = tools.some((tool) => tool.name === 'run_command');

  const start = await parent.hooks.subagentStart(
    hookContext,
    name,
    brief(run.task, run.files, check, canRun),
  );
  for (const failure of start.failures) report(parent.stamp(hookFailureEvent(failure)));
  if (start.block !== undefined)
    return { output: `Blocked by a hook: ${start.block}`, isError: true };
  const task = start.task;

  const restriction: PermissionRestriction = {
    ...(definition?.mode && { mode: definition.mode }),
    ...(run.files?.length && { writable: run.files }),
  };
  const base = definition?.limits ?? run.settings.limits ?? DEFAULT_LIMITS;
  const session = await run.createSession({
    name,
    agentId: run.agentId,
    parent,
    definition,
    instructions: run.instructions,
    tools,
    limits: withinBudget(base, run.budget),
    permissions: Object.keys(restriction).length
      ? parent.permissions.restricted(restriction)
      : parent.permissions,
    signal,
  });

  report(
    parent.stamp({
      type: 'subagent.start',
      childAgentId: run.agentId,
      name,
      task,
      callId: run.callId,
    }),
  );
  // Its runs: the task, and once more if it reports without having made its check pass.
  let end: Extract<EngineEvent, { type: 'run.end' }> | undefined;
  const total = {
    turns: 0,
    usage: emptyUsage(),
    costUsd: undefined as number | undefined,
  };
  const drive = async (input: string, limits?: Partial<RunLimits>) => {
    for await (const event of session.send(input, { signal, ...(limits && { limits }) })) {
      report(event);
      if (event.type !== 'run.end' || event.agentId !== run.agentId) continue;
      end = event;
      total.turns += event.turns;
      total.usage = addUsage(total.usage, event.usage);
      if (event.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + event.costUsd;
    }
  };
  await drive(task);
  let checkNote = '';
  if (check && canRun && end?.stopReason === 'end_turn' && !checkPassed(session.messages, check)) {
    await drive(
      `Before you report: run \`${check}\` and make it pass. It has not passed in this task yet.`,
      withinBudget(base, parent.remaining()),
    );
    if (!checkPassed(session.messages, check)) {
      checkNote = `\n\n[The check \`${check}\` did not pass in the sub-agent; run it yourself.]`;
    }
  }
  const stopReason = end?.stopReason ?? 'error';

  const text = lastAnswer(session.messages) || '(The sub-agent finished without a report.)';
  const finished = await parent.hooks.subagentEnd(hookContext, {
    agent: name,
    task,
    result: text,
    stopReason,
    usage: total.usage,
  });
  for (const failure of finished.failures) report(parent.stamp(hookFailureEvent(failure)));
  report(
    parent.stamp({
      type: 'subagent.end',
      childAgentId: run.agentId,
      name,
      stopReason,
      turns: total.turns,
      usage: total.usage,
      ...(total.costUsd !== undefined && { costUsd: total.costUsd }),
    }),
  );
  const early = STOPPED_EARLY[stopReason];
  return {
    output:
      (early
        ? `${finished.result}\n\n[The sub-agent ${early}, so its report may be incomplete.]`
        : finished.result) + checkNote,
    isError: stopReason === 'error',
  };
}

/** The task as the sub-agent gets it: with its files and its check, when given. */
function brief(
  task: string,
  files: string[] | undefined,
  check: string | undefined,
  canRun: boolean,
): string {
  const parts = [task];
  if (files?.length) {
    parts.push(`Files you may change: ${files.join(', ')}. Changes to other files are denied.`);
  }
  if (check) {
    parts.push(
      canRun
        ? `Done when \`${check}\` passes: run it and make it pass before you report.`
        : `When you report, the agent that gave you this task runs \`${check}\`.`,
    );
  }
  return parts.join('\n\n');
}

/** Whether the last run of `check` in this conversation passed (alone or chained with others). */
function checkPassed(messages: Message[], check: string): boolean {
  const wanted = check.trim().replace(/\s+/g, ' ');
  const runsCheck = new Set<string>();
  let passed = false;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool-call' && part.name === 'run_command') {
        const command = (part.args as { command?: unknown } | undefined)?.command;
        const commands = typeof command === 'string' ? (splitCommands(command) ?? []) : [];
        if (commands.some(({ text }) => text.replace(/\s+/g, ' ') === wanted)) {
          runsCheck.add(part.id);
        }
      }
      if (part.type === 'tool-result' && runsCheck.has(part.callId)) passed = !part.isError;
    }
  }
  return passed;
}

/** What each of `together` sub-agents may spend of what the run has left. */
function shareOf(left: Budget, together: number): Budget {
  const n = Math.max(1, together);
  return {
    ...(left.tokens !== undefined && { tokens: Math.floor(left.tokens / n) }),
    ...(left.costUsd !== undefined && { costUsd: left.costUsd / n }),
  };
}

/** Why a sub-agent is not started, when its share is too small to finish anything. */
function tooLittle(
  share: Budget,
  left: Budget,
  together: number,
  settings: SubagentSettings,
): string | undefined {
  const min = { ...DEFAULT_MIN_BUDGET, ...settings.minBudget };
  const each = together > 1 ? ` (${together} sub-agents started together share it)` : '';
  const advice =
    'Do the rest yourself in a few steps, or stop and tell the user what is done and what is ' +
    'left, so they can continue in a new message.';
  if (share.costUsd !== undefined && share.costUsd < min.costUsd) {
    return (
      `Not started: this message has $${(left.costUsd ?? 0).toFixed(2)} of its cost limit ` +
      `left${each}, too little for a sub-agent to finish a task. ${advice}`
    );
  }
  if (share.tokens !== undefined && share.tokens < min.tokens) {
    return (
      `Not started: this message has ${left.tokens ?? 0} tokens of its limit left${each}, too ` +
      `little for a sub-agent to finish a task. ${advice}`
    );
  }
  return undefined;
}

const STOPPED_EARLY: Partial<Record<StopReason, string>> = {
  max_turns: 'reached its turn limit',
  token_limit: 'reached its token limit',
  cost_limit: 'reached its cost limit',
  time_limit: 'reached its time limit',
  max_tokens: 'hit the model output limit',
  check_failed: 'kept failing the same check',
  content_filter: "was stopped by the provider's content filter",
  aborted: 'was interrupted',
  error: 'failed',
};

/** A sub-agent's token and cost limits never exceed its share of what the parent has left. */
function withinBudget(base: Partial<RunLimits>, left: Budget): Partial<RunLimits> {
  const tighter = (own: number | undefined, rest: number | undefined) =>
    own === undefined ? rest : rest === undefined ? own : Math.min(own, rest);
  const maxTokens = tighter(base.maxTokens, left.tokens);
  const maxCostUsd = tighter(base.maxCostUsd, left.costUsd);
  return {
    ...base,
    ...(maxTokens !== undefined && { maxTokens }),
    ...(maxCostUsd !== undefined && { maxCostUsd }),
  };
}

/** A counting semaphore: at most `size` sub-agents at once, the rest wait in order. */
class Slots {
  #free: number;
  readonly #waiting: Array<() => void> = [];

  constructor(size: number) {
    this.#free = Math.max(1, size);
  }

  async acquire(signal: AbortSignal): Promise<void> {
    if (this.#free > 0) {
      this.#free--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.#waiting.splice(this.#waiting.indexOf(wake), 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push(wake);
    });
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free++;
  }
}

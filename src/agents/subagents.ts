import { z } from 'zod';
import type { EngineEvent, StopReason } from '../core/events.js';
import { hookFailureEvent } from '../core/hooks.js';
import type { RunLimits } from '../core/loop.js';
import { lastAnswer } from '../core/messages.js';
import type { PermissionPolicy } from '../core/permissions.js';
import type { Session } from '../core/session.js';
import type { AgentContext, Tool, ToolOutput } from '../core/tools.js';
import { emptyUsage } from '../core/usage.js';
import { defineTool } from '../tools/define.js';
import type { AgentDefinition } from './definitions.js';

export interface SubagentSettings {
  /** How deep agents may nest: 1 means sub-agents cannot start their own. Default: 1. */
  maxDepth?: number;
  /** Sub-agents running at the same time; more wait their turn. Default: 4. */
  maxParallel?: number;
  /** Limits for each sub-agent whose definition sets none. Default: 50 turns. */
  limits?: Partial<RunLimits>;
}

export const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_LIMITS: Partial<RunLimits> = { maxTurns: 50 };

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
      'times in one turn. The sub-agent sees only `task`, not this conversation: include the ' +
      `goal, the relevant files and facts, constraints, and what to report.\n${named}` +
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
      await slots.acquire(context.signal);
      try {
        return await runSubagent({
          parent,
          definition,
          task: args.task,
          instructions: args.instructions,
          toolNames: args.tools,
          agentId: `${definition?.name ?? 'agent'}-${++started}`,
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
  agentId: string;
  settings: SubagentSettings;
  createSession: CreateSubagentSession;
  signal: AbortSignal;
}): Promise<ToolOutput> {
  const { parent, definition, signal } = run;
  const name = definition?.name ?? 'agent';
  const hookContext = parent.hookContext(signal);
  const report = (event: EngineEvent) => parent.emit(event);

  const start = await parent.hooks.subagentStart(hookContext, name, run.task);
  for (const failure of start.failures) report(parent.stamp(hookFailureEvent(failure)));
  if (start.block !== undefined)
    return { output: `Blocked by a hook: ${start.block}`, isError: true };
  const task = start.task;

  const maxDepth = run.settings.maxDepth ?? DEFAULT_MAX_DEPTH;
  const wanted = definition?.tools ?? run.toolNames;
  const tools = parent
    .tools()
    .filter((tool) => !wanted || wanted.includes(tool.name))
    // Nesting stops at the depth limit.
    .filter((tool) => tool.name !== 'delegate' || parent.depth + 1 < maxDepth)
    // Plan mode belongs to the user's agent.
    .filter((tool) => tool.name !== 'start_plan' && tool.name !== 'finish_plan');
  const session = await run.createSession({
    name,
    agentId: run.agentId,
    parent,
    definition,
    instructions: run.instructions,
    tools,
    limits: withinBudget(definition?.limits ?? run.settings.limits ?? DEFAULT_LIMITS, parent),
    permissions: definition?.mode
      ? parent.permissions.restricted({ mode: definition.mode })
      : parent.permissions,
    signal,
  });

  report(parent.stamp({ type: 'subagent.start', childAgentId: run.agentId, name, task }));
  let end: Extract<EngineEvent, { type: 'run.end' }> | undefined;
  for await (const event of session.send(task, { signal })) {
    report(event);
    if (event.type === 'run.end' && event.agentId === run.agentId) end = event;
  }
  const stopReason = end?.stopReason ?? 'error';
  const usage = end?.usage ?? emptyUsage();

  const text = lastAnswer(session.messages) || '(The sub-agent finished without a report.)';
  const finished = await parent.hooks.subagentEnd(hookContext, {
    agent: name,
    task,
    result: text,
    stopReason,
    usage,
  });
  for (const failure of finished.failures) report(parent.stamp(hookFailureEvent(failure)));
  report(
    parent.stamp({
      type: 'subagent.end',
      childAgentId: run.agentId,
      name,
      stopReason,
      turns: end?.turns ?? 0,
      usage,
      ...(end?.costUsd !== undefined && { costUsd: end.costUsd }),
    }),
  );
  const early = STOPPED_EARLY[stopReason];
  return {
    output: early
      ? `${finished.result}\n\n[The sub-agent ${early}, so its report may be incomplete.]`
      : finished.result,
    isError: stopReason === 'error',
  };
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

/** A sub-agent's token and cost limits never exceed what its parent's run has left. */
function withinBudget(base: Partial<RunLimits>, parent: AgentContext): Partial<RunLimits> {
  const left = parent.remaining();
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

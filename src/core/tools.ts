import type {
  ApprovalDecision,
  ApprovalRequest,
  EngineEvent,
  EngineEventBody,
  ToolStatus,
} from './events.js';
import type { FileChanges } from './changes.js';
import type { ToolImage } from './messages.js';
import type { HookContext, HookRunner } from './hooks.js';
import type { ModelClient } from './model.js';
import type { PermissionPolicy, ToolKind } from './permissions.js';
import type { Workspace } from './workspace.js';

export type { ToolKind, ToolStatus };

/**
 * A tool the model can call. Schema-agnostic on purpose: built-in and custom tools are created
 * with `defineTool` (zod), MCP tools arrive with plain JSON Schema.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  /** JSON Schema of the arguments, sent to the model. */
  readonly inputSchema: Record<string, unknown>;
  /** Read tools default to `parallel`, everything else to `serial`. */
  readonly concurrency?: 'parallel' | 'serial' | undefined;
  /** How permission rules match the subject: as a path glob or as plain text. Default: `text`. */
  readonly subjectType?: 'path' | 'text' | undefined;
  /** Asked about every time, in every mode, unless approved in advance (deny rules still win). */
  readonly alwaysAsk?: boolean | undefined;
  /**
   * How its output is cut when too long: at most `maxChars` (below the session's limit), keeping
   * `headShare` of it from the start and the rest from the end. The full output is saved.
   */
  readonly output?: { maxChars?: number; headShare?: number } | undefined;

  /** Validates arguments from the model. An error message goes back to the model. */
  parse(args: unknown): { ok: true; args: unknown } | { ok: false; error: string };
  /** What permission rules match against: the command, the path or the host. */
  subject?(args: unknown): string | undefined;
  /**
   * Why the call cannot run now, checked before permissions, so the user is not asked to approve
   * a call that would fail anyway (e.g. approving a plan that was never written).
   */
  precheck?(args: unknown, context: ToolPrecheckContext): Promise<string | undefined>;
  /** Throwing is fine: the error message becomes an error result for the model. */
  run(args: unknown, context: ToolContext): Promise<ToolOutput>;
}

/** What a tool's `precheck` can look at: the workspace, and whether the agent is in plan mode. */
export interface ToolPrecheckContext {
  workspace: Workspace;
  agent?: Pick<AgentContext, 'id' | 'depth' | 'plan'> | undefined;
}

export interface ToolContext {
  workspace: Workspace;
  signal: AbortSignal;
  callId: string;
  /** How many calls of this tool run together with this one (parallel calls of one turn). */
  together?: number;
  /** Per-session storage for tools, e.g. which files have been read. Key by tool or toolset. */
  state: Map<string, unknown>;
  /** The agent running the tool, for tools that start sub-agents (`delegate`). */
  agent?: AgentContext | undefined;
}

/**
 * What a sub-agent inherits from the agent that starts it (docs/DESIGN.md §4.7): never more
 * tools or looser permissions, the same approvals channel, and what is left of the budget.
 */
export interface AgentContext {
  /** This agent's id: `main` for the user's agent. */
  id: string;
  /** 0 for the user's agent, 1 for its sub-agents, and so on. */
  depth: number;
  model: ModelClient;
  /** The tools this agent has right now; a sub-agent gets some of these. */
  tools: () => Tool[];
  permissions: PermissionPolicy;
  /** Whether someone answers approval requests. */
  interactive: boolean;
  /**
   * Waits for the user's answer through the session that owns the conversation. `allowedNow`:
   * whether the call no longer needs asking (another answer "for the session" covers it).
   */
  requestApproval: (
    request: ApprovalRequest,
    signal: AbortSignal,
    allowedNow?: () => boolean,
  ) => Promise<ApprovalDecision>;
  /** Tokens and cost the current run may still spend; missing values are unlimited. */
  remaining: () => { tokens?: number; costUsd?: number };
  hooks: HookRunner;
  hookContext: (signal: AbortSignal) => HookContext;
  /** Adds this agent's ids and a timestamp to an event. */
  stamp: (body: EngineEventBody) => EngineEvent;
  /** Passes an event on to this agent's consumers, e.g. one from a sub-agent. */
  emit: (event: EngineEvent) => void;
  /** What the run's file tools change; a sub-agent's changes count as its parent's run. */
  changes?: FileChanges | undefined;
  /** Plan mode of the user's agent; sub-agents have none. */
  plan?: PlanControl | undefined;
  /** Named agents `delegate` started in the current run, by name, for their `maxRuns`. */
  started?: Map<string, number> | undefined;
}

/** Switches plan mode (docs/DESIGN.md §4.8) from a tool. */
export interface PlanControl {
  active(): boolean;
  /** Read-only except the plan file, thinking harder. */
  enter(): void;
  /** Back to the mode and effort from before; false when plan mode was off. */
  leave(): boolean;
  /** The user approved the plan: the agent builds it, and is kept at it until it is done. */
  build(): void;
}

export type ToolOutput =
  | string
  | {
      output: string;
      isError?: boolean;
      /** Images for models that can see them, such as a screenshot; describe them in `output`. */
      images?: ToolImage[];
    };

/**
 * Tool state under keys with this prefix describes what the model has seen in the conversation
 * (e.g. which file contents it was shown). It is cleared when the history is compacted, since
 * those results may be gone then.
 */
export const CONTEXT_STATE_PREFIX = 'context.';

export function forgetSeen(state: Map<string, unknown>): void {
  for (const key of [...state.keys()]) if (key.startsWith(CONTEXT_STATE_PREFIX)) state.delete(key);
}

export function concurrencyOf(tool: Tool): 'parallel' | 'serial' {
  return tool.concurrency ?? (tool.kind === 'read' ? 'parallel' : 'serial');
}

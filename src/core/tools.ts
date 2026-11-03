import type {
  ApprovalDecision,
  ApprovalRequest,
  EngineEvent,
  EngineEventBody,
  ToolStatus,
} from './events.js';
import type { FileChanges } from './changes.js';
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

  /** Validates arguments from the model. An error message goes back to the model. */
  parse(args: unknown): { ok: true; args: unknown } | { ok: false; error: string };
  /** What permission rules match against: the command, the path or the host. */
  subject?(args: unknown): string | undefined;
  /** Throwing is fine: the error message becomes an error result for the model. */
  run(args: unknown, context: ToolContext): Promise<ToolOutput>;
}

export interface ToolContext {
  workspace: Workspace;
  signal: AbortSignal;
  callId: string;
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
  /** Waits for the user's answer through the session that owns the conversation. */
  requestApproval: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
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
}

export type ToolOutput = string | { output: string; isError?: boolean };

export function concurrencyOf(tool: Tool): 'parallel' | 'serial' {
  return tool.concurrency ?? (tool.kind === 'read' ? 'parallel' : 'serial');
}

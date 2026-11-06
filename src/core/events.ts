import type { SerializedError } from './errors.js';
import type { AssistantMessage } from './messages.js';
import type { Usage } from './usage.js';

export type ToolStatus = 'ok' | 'error' | 'denied' | 'cancelled';

/** A tool call that waits for the user's answer. */
export interface ApprovalRequest {
  requestId: string;
  callId: string;
  tool: string;
  args: unknown;
  /** The command, path or host the permission rules looked at. */
  subject: string | undefined;
  reason: string;
  /** What answering "yes for the session" allows, e.g. all file edits. */
  forSession?: string | undefined;
}

/**
 * The answer to an `approval.request`. `session` also allows the call for the rest of the
 * session, and what `forSession` says (all file edits, or commands with the same leading words).
 */
export type ApprovalDecision =
  { allow: true; scope: 'once' | 'session' } | { allow: false; feedback?: string | undefined };

/**
 * Why a run ended.
 * - `end_turn`: the model finished and has nothing more to do.
 * - `max_tokens`: the model hit its output limit mid-answer.
 * - `max_turns`: the run hit its turn limit while the model still wanted to continue.
 * - `token_limit`, `cost_limit`, `time_limit`: the run reached one of its other limits.
 * - `blocked`: a `userPrompt` hook rejected the input.
 * - `check_failed`: a `beforeStop` check failed the same way several times in a row, so the
 *   agent is stuck (or the check cannot run) and a person has to look.
 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turns'
  | 'token_limit'
  | 'cost_limit'
  | 'time_limit'
  | 'blocked'
  | 'check_failed'
  | 'content_filter'
  | 'aborted'
  | 'error';

/** The hooks a project can register (docs/DESIGN.md §4.11). */
export const HOOK_NAMES = [
  'sessionStart',
  'userPrompt',
  'beforeModelCall',
  'afterModelCall',
  'beforeToolCall',
  'afterToolCall',
  'beforeStop',
  'beforeCompact',
  'subagentStart',
  'subagentEnd',
  'sessionEnd',
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

/** Fields every event carries. `parentAgentId` is set for sub-agent events. */
export interface EventBase {
  sessionId: string;
  agentId: string;
  parentAgentId?: string;
  timestamp: number;
}

/**
 * Everything the engine does, as a stream. A run handles one user input; a turn is one
 * model call plus the tool calls it requested. UIs, loggers and tests consume these.
 */
export type EngineEventBody =
  /** `intent`: what the session is for (build, explore, ask, …), when it was given. */
  | { type: 'run.start'; input: string; intent?: string }
  | {
      type: 'run.end';
      stopReason: StopReason;
      usage: Usage;
      turns: number;
      /** Cost of the run in USD; missing when the model's price is unknown. */
      costUsd?: number;
    }
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'message.complete'; message: AssistantMessage }
  | { type: 'tool.start'; callId: string; tool: string; args: unknown }
  | {
      type: 'tool.end';
      callId: string;
      tool: string;
      output: string;
      status: ToolStatus;
      isError: boolean;
      durationMs: number;
    }
  | {
      type: 'approval.request';
      requestId: string;
      callId: string;
      tool: string;
      args: unknown;
      /** The command, path or host the permission rules looked at. */
      subject: string | undefined;
      reason: string;
      /** What answering "yes for the session" allows, e.g. all file edits. */
      forSession?: string | undefined;
    }
  | { type: 'approval.response'; requestId: string; decision: ApprovalDecision }
  /** One model call's usage, and its cost when the price is known. */
  | { type: 'usage'; usage: Usage; costUsd?: number; /** `provider:model` */ model?: string }
  /** The history was shortened to fit the context window (docs/DESIGN.md §4.9). */
  | {
      type: 'compaction';
      trigger: 'auto' | 'manual';
      /** `tool-results`: old tool outputs were cleared; `summary`: older turns were summarized. */
      method: 'tool-results' | 'summary';
      beforeTokens: number;
      afterTokens: number;
    }
  /** A hook changed what happens, e.g. blocked a prompt or asked the agent to keep working. */
  | {
      type: 'hook';
      hook: HookName;
      message: string;
      /** heaw's own reminder (changes nothing checked, plan steps still open), not a config hook. */
      builtIn?: boolean;
    }
  /**
   * The run used most of a limit (`NEAR_LIMIT`), so the agent was asked to finish what it is
   * doing and report what is left, rather than be cut off mid-step.
   */
  | {
      type: 'limit.near';
      limit: 'turns' | 'tokens' | 'cost' | 'time';
      /** Turns, tokens, USD or minutes. */
      used: number;
      max: number;
    }
  /**
   * The agent seems to be going in circles (docs/DESIGN.md §4.1): a call failed the same way
   * again (`same-failure`), or a file went back to content it had earlier in the run, for the
   * second time (`back-and-forth`). The agent was told to step back, on that call's result.
   */
  | {
      type: 'stuck';
      signal: 'same-failure' | 'back-and-forth';
      /** The command, tool or file. */
      subject: string;
      /** How often it failed the same way, or went back to earlier content. */
      count: number;
    }
  /**
   * A sub-agent started (docs/DESIGN.md §4.7). Its own events carry `parentAgentId`; `callId` is
   * the `delegate` call that started it, so a UI can show its progress on that call.
   */
  | { type: 'subagent.start'; childAgentId: string; name: string; task: string; callId?: string }
  | {
      type: 'subagent.end';
      childAgentId: string;
      name: string;
      stopReason: StopReason;
      turns: number;
      usage: Usage;
      costUsd?: number;
    }
  /**
   * Something the run produced outside the conversation, to link the session to it
   * (docs/DESIGN.md §4.13): a pull request it opened (`ref`: its URL) or a commit it made
   * (`ref`: the hash, `title`: the subject line).
   */
  | { type: 'link'; kind: 'pull_request' | 'commit'; ref: string; title?: string }
  | { type: 'error'; error: SerializedError; recoverable: boolean };

export type EngineEvent = EngineEventBody & EventBase;

export type EngineEventType = EngineEvent['type'];

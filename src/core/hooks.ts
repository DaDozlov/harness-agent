import type { EngineEventBody, HookName, StopReason, ToolStatus } from './events.js';
import type { AssistantMessage, Message } from './messages.js';
import type { ModelRequest } from './model.js';
import type { Usage } from './usage.js';
import type { Workspace } from './workspace.js';

/** What every hook receives. */
export interface HookContext {
  sessionId: string;
  agentId: string;
  /** The model's `provider:model` id. */
  model: string;
  workspace: Workspace;
  /** Aborted when the run is interrupted. */
  signal: AbortSignal;
  /**
   * Runs a named agent (or `main`) on a task and returns its answer, e.g. a reviewer in
   * `beforeStop`. Nobody is asked, so it can only do what the rules allow without asking; it
   * has its own limits and runs only tool hooks. Not available inside sub-agents, or in agents
   * started this way.
   */
  runAgent?: ((name: string, task: string) => Promise<HookAgentResult>) | undefined;
}

/** What `HookContext.runAgent` returns. */
export interface HookAgentResult {
  text: string;
  stopReason: StopReason;
  costUsd?: number;
  turns?: number;
  usage?: Usage;
}

type Result<T> = T | undefined | void | Promise<T | undefined | void>;

/**
 * Functions a project runs at fixed points of a session (docs/DESIGN.md §4.11). Each may return
 * nothing to leave things as they are.
 */
export interface Hooks {
  /** Before a session's first run (a resumed one too): add context to the system prompt. */
  sessionStart?: (context: HookContext & { resumed: boolean }) => Result<{ context?: string }>;
  /** Before a user input joins the history: rewrite it, add context to it, or block it. */
  userPrompt?: (
    context: HookContext & { prompt: string },
  ) => Result<{ prompt?: string; context?: string; block?: string }>;
  /** Before each model call: change the request. */
  beforeModelCall?: (
    context: HookContext & { request: ModelRequest; turn: number },
  ) => Result<{ request?: ModelRequest }>;
  /** After each model call, e.g. to log the answer. */
  afterModelCall?: (
    context: HookContext & { message: AssistantMessage; usage: Usage; turn: number },
  ) => Result<void>;
  /**
   * Before a tool call's permission check: block it, change its arguments, or allow it without
   * asking. Deny rules still apply to calls a hook allows.
   */
  beforeToolCall?: (
    context: HookContext & { tool: string; args: unknown; callId: string },
  ) => Result<{ block?: string; args?: unknown; allow?: boolean }>;
  /** After a call ran: add feedback to its output, e.g. lint errors after an edit. */
  afterToolCall?: (
    context: HookContext & { tool: string; args: unknown; output: string; status: ToolStatus },
  ) => Result<{ feedback?: string }>;
  /** When the agent is about to finish: `continue` with feedback to keep it working. */
  beforeStop?: (
    context: HookContext & {
      message: AssistantMessage;
      turns: number;
      /** Files the file tools changed in this run (commands' changes are not seen). */
      editedFiles: string[];
    },
  ) => Result<{
    continue?: boolean;
    feedback?: string;
    /**
     * The check passed, and the agent should know what it found before it finishes, e.g. "the
     * tester used the page: works". It gets the note once and gives its final answer again;
     * the checks do not run again unless files changed since.
     */
    note?: string;
  }>;
  /** Before older turns are summarized (`messages`: the whole history): text to keep word for word. */
  beforeCompact?: (
    context: HookContext & { messages: readonly Message[] },
  ) => Result<{ preserve?: string }>;
  /** Before a sub-agent starts: change its task, or block it. */
  subagentStart?: (
    context: HookContext & { agent: string; task: string },
  ) => Result<{ task?: string; block?: string }>;
  /** After a sub-agent finished: change or add to the report the calling agent gets. */
  subagentEnd?: (
    context: HookContext & {
      agent: string;
      task: string;
      result: string;
      stopReason: StopReason;
      usage: Usage;
    },
  ) => Result<{ result?: string }>;
  /** When a session is closed, e.g. to export a report. */
  sessionEnd?: (
    context: HookContext & { usage: Usage; costUsd: number | undefined },
  ) => Result<void>;
}

/** A hook that threw: reported as a recoverable error, and otherwise skipped. */
export interface HookFailure {
  hook: HookName;
  message: string;
}

const DEFAULT_STOP_FEEDBACK = 'A check before finishing did not pass. Keep working on the task.';

/** Hooks about the user's conversation, which sub-agents do not run. */
const CONVERSATION_HOOKS = new Set<HookName>([
  'sessionStart',
  'userPrompt',
  'beforeStop',
  'sessionEnd',
]);

/** The recoverable error event that reports a failed hook. */
export function hookFailureEvent(failure: HookFailure): EngineEventBody {
  return {
    type: 'error',
    error: { name: 'HookError', message: `The ${failure.hook} hook failed: ${failure.message}` },
    recoverable: true,
  };
}

/**
 * Runs the registered hooks, in order. Rewrites (prompt, request, arguments) pass from one hook
 * to the next; added context and feedback are joined. A failing hook is reported and skipped,
 * except `beforeToolCall`, which fails closed: the call is blocked.
 */
export class HookRunner {
  readonly #hooks: Hooks[];

  constructor(hooks?: Hooks | Hooks[]) {
    this.#hooks = hooks === undefined ? [] : [hooks].flat();
  }

  has(name: HookName): boolean {
    return this.#hooks.some((hooks) => hooks[name] !== undefined);
  }

  async sessionStart(context: HookContext, resumed: boolean) {
    const failures: HookFailure[] = [];
    const parts: string[] = [];
    for (const hook of this.#all('sessionStart')) {
      const result = await attempt('sessionStart', () => hook({ ...context, resumed }), failures);
      if (result?.context) parts.push(result.context);
    }
    return { context: joined(parts), failures };
  }

  async userPrompt(context: HookContext, prompt: string) {
    const failures: HookFailure[] = [];
    const parts: string[] = [];
    for (const hook of this.#all('userPrompt')) {
      const result = await attempt('userPrompt', () => hook({ ...context, prompt }), failures);
      if (result?.block) return { prompt, block: result.block, failures };
      if (result?.prompt !== undefined) prompt = result.prompt;
      if (result?.context) parts.push(result.context);
    }
    return { prompt, context: joined(parts), failures };
  }

  async beforeModelCall(context: HookContext, request: ModelRequest, turn: number) {
    const failures: HookFailure[] = [];
    for (const hook of this.#all('beforeModelCall')) {
      const result = await attempt(
        'beforeModelCall',
        () => hook({ ...context, request, turn }),
        failures,
      );
      if (result?.request) request = result.request;
    }
    return { request, failures };
  }

  async afterModelCall(
    context: HookContext,
    message: AssistantMessage,
    usage: Usage,
    turn: number,
  ) {
    const failures: HookFailure[] = [];
    for (const hook of this.#all('afterModelCall')) {
      await attempt('afterModelCall', () => hook({ ...context, message, usage, turn }), failures);
    }
    return { failures };
  }

  async beforeToolCall(context: HookContext, tool: string, args: unknown, callId: string) {
    let allow = false;
    for (const hook of this.#all('beforeToolCall')) {
      const failures: HookFailure[] = [];
      const result = await attempt(
        'beforeToolCall',
        () => hook({ ...context, tool, args, callId }),
        failures,
      );
      // A guard that crashed cannot vouch for the call.
      if (failures.length)
        return { block: `the beforeToolCall hook failed: ${failures[0]!.message}` };
      if (result?.block) return { block: result.block };
      if (result?.args !== undefined) args = result.args;
      if (result?.allow) allow = true;
    }
    return { args, allow };
  }

  async afterToolCall(
    context: HookContext,
    call: { tool: string; args: unknown; output: string; status: ToolStatus },
  ) {
    const failures: HookFailure[] = [];
    const parts: string[] = [];
    for (const hook of this.#all('afterToolCall')) {
      const result = await attempt('afterToolCall', () => hook({ ...context, ...call }), failures);
      if (result?.feedback) parts.push(result.feedback);
    }
    return { feedback: joined(parts), failures };
  }

  /** Feedback to continue with, or undefined when every hook lets the agent stop. */
  async beforeStop(
    context: HookContext,
    message: AssistantMessage,
    turns: number,
    editedFiles: string[] = [],
  ) {
    const failures: HookFailure[] = [];
    const parts: string[] = [];
    const notes: string[] = [];
    for (const hook of this.#all('beforeStop')) {
      const result = await attempt(
        'beforeStop',
        () => hook({ ...context, message, turns, editedFiles }),
        failures,
      );
      if (result?.continue) parts.push(result.feedback || DEFAULT_STOP_FEEDBACK);
      else if (result?.note) notes.push(result.note);
    }
    return { feedback: joined(parts), note: joined(notes), failures };
  }

  async beforeCompact(context: HookContext, messages: readonly Message[]) {
    const failures: HookFailure[] = [];
    const parts: string[] = [];
    for (const hook of this.#all('beforeCompact')) {
      const result = await attempt('beforeCompact', () => hook({ ...context, messages }), failures);
      if (result?.preserve) parts.push(result.preserve);
    }
    return { preserve: joined(parts), failures };
  }

  async subagentStart(context: HookContext, agent: string, task: string) {
    const failures: HookFailure[] = [];
    for (const hook of this.#all('subagentStart')) {
      const result = await attempt(
        'subagentStart',
        () => hook({ ...context, agent, task }),
        failures,
      );
      if (result?.block) return { task, block: result.block, failures };
      if (result?.task !== undefined) task = result.task;
    }
    return { task, failures };
  }

  async subagentEnd(
    context: HookContext,
    run: { agent: string; task: string; result: string; stopReason: StopReason; usage: Usage },
  ) {
    const failures: HookFailure[] = [];
    let { result } = run;
    for (const hook of this.#all('subagentEnd')) {
      const changed = await attempt(
        'subagentEnd',
        () => hook({ ...context, ...run, result }),
        failures,
      );
      if (changed?.result !== undefined) result = changed.result;
    }
    return { result, failures };
  }

  /**
   * The hooks that apply inside sub-agents: tool, model call and compaction hooks (so guards
   * still hold), not the ones about the user's conversation.
   */
  forSubagents(): HookRunner {
    return new HookRunner(
      this.#hooks.map(
        (hooks) =>
          Object.fromEntries(
            Object.entries(hooks).filter(([name]) => !CONVERSATION_HOOKS.has(name as HookName)),
          ) as Hooks,
      ),
    );
  }

  async sessionEnd(context: HookContext, usage: Usage, costUsd: number | undefined) {
    const failures: HookFailure[] = [];
    for (const hook of this.#all('sessionEnd')) {
      await attempt('sessionEnd', () => hook({ ...context, usage, costUsd }), failures);
    }
    return { failures };
  }

  #all<K extends HookName>(name: K): Array<NonNullable<Hooks[K]>> {
    return this.#hooks.flatMap((hooks) => (hooks[name] ? [hooks[name]] : []));
  }
}

async function attempt<T>(
  hook: HookName,
  call: () => Result<T>,
  failures: HookFailure[],
): Promise<T | undefined> {
  try {
    return (await call()) ?? undefined;
  } catch (error) {
    failures.push({ hook, message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function joined(parts: string[]): string | undefined {
  return parts.length ? parts.join('\n\n') : undefined;
}

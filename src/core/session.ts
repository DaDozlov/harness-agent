import { randomUUID } from 'node:crypto';
import { type ChangedRun, FileChanges, type RewindReport } from './changes.js';
import { compactHistory, ContextMeter, usableWindow } from './context.js';
import type { ApprovalDecision, ApprovalRequest, EngineEvent, EngineEventBody } from './events.js';
import { commitsSince, gitHead, gitState } from './git.js';
import {
  type HookContext,
  type HookFailure,
  hookFailureEvent,
  HookRunner,
  type Hooks,
} from './hooks.js';
import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type RunLimits,
  type RunResult,
  runLoop,
} from './loop.js';
import type { Message } from './messages.js';
import type { ModelClient, ToolSpec } from './model.js';
import { type PermissionMode, PermissionPolicy, type PermissionRules } from './permissions.js';
import { completedTodos, PLAN_FILE, readPlanSteps } from './plan.js';
import {
  createSessionId,
  type SessionHeader,
  type SessionRecord,
  type SessionStore,
} from './session-store.js';
import { executeToolCalls, type ToolRuntime } from './tool-execution.js';
import type { Tool, ToolStatus } from './tools.js';
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from './truncate.js';
import { addUsage, costOf, emptyUsage, type Usage } from './usage.js';
import { type UsageBreakdown, UsageStats } from './usage-stats.js';
import type { Workspace } from './workspace.js';

export { PLAN_FILE };

export const DEFAULT_MAX_TURNS = 100;
/** Compact when a request would use more than this share of the usable context window. */
export const DEFAULT_COMPACT_AT = 0.8;

/**
 * Notes, docs and files no check covers (`.gitignore`, `.env.example`, …), and heaw's own files:
 * its config and MCP servers are checked by check_config.
 */
const NOTHING_TO_CHECK = new RegExp(
  [
    String.raw`(^|/)\.heaw/`,
    String.raw`(^|/)heaw\.config\.[cm]?[jt]s$`,
    String.raw`(^|/)\.(mcp\.json|gitignore|gitattributes|dockerignore|editorconfig|env\.example)$`,
    String.raw`(^|/)LICENSE[^/]*$`,
    String.raw`\.(md|mdx|txt)$`,
  ].join('|'),
  'i',
);

const SKIPPED_EVENTS = new Set<EngineEvent['type']>([
  'text.delta',
  'reasoning.delta',
  'message.complete',
]);

export interface SessionOptions {
  model: ModelClient;
  /** The system prompt, or a function read before each model turn. */
  system: string | (() => string);
  /** Required when `tools` is not empty: tools act through it. */
  workspace?: Workspace | undefined;
  /** Tools, or a function read before each model turn (for tools that come and go, like MCP). */
  tools?: Tool[] | (() => Tool[]) | undefined;
  permissions?: PermissionRules | PermissionPolicy | undefined;
  /**
   * Whether someone answers approval requests via `approve`. When `false`, actions that need
   * approval are denied and the model is told how to allow them. Default: `true`.
   */
  interactive?: boolean | undefined;
  /** Limits per run. Default: 100 turns, nothing else. */
  limits?: Partial<RunLimits> | undefined;
  maxToolOutputChars?: number | undefined;
  retry?: Partial<RetryPolicy> | undefined;
  id?: string | undefined;
  agentId?: string | undefined;
  /** For a sub-agent: the agent that started it. Stamped on every event. */
  parentAgentId?: string | undefined;
  /** 0 for the user's agent, 1 for its sub-agents, and so on. */
  depth?: number | undefined;
  /**
   * Where approval requests go. A sub-agent passes them to the session that owns the
   * conversation, so the user answers them there. Default: this session's `approve`.
   */
  requestApproval?:
    ((request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>) | undefined;
  /** Saves the session as it goes, so it can be resumed. */
  store?: SessionStore | undefined;
  /** Earlier messages to continue from, e.g. a restored session. */
  history?: Message[] | undefined;
  /** Usage of the earlier messages, so totals stay right after a resume. */
  usage?: Usage | undefined;
  /** Cost of the earlier messages in USD, when known. */
  costUsd?: number | undefined;
  /** Where the earlier messages' tokens went, after a resume. */
  stats?: UsageStats | undefined;
  hooks?: Hooks | Hooks[] | HookRunner | undefined;
  /** Share of the usable context window that triggers compaction, or `false` for never. */
  compactAt?: number | false | undefined;
  /** Awaited before each run, e.g. so MCP servers can finish connecting before the first turn. */
  beforeRun?: (() => Promise<void>) | undefined;
  /** Shown in the saved session header. Default: the workspace root or the current directory. */
  cwd?: string | undefined;
  /** Sees every event, sub-agents' included, e.g. to export traces. */
  observe?: ((event: EngineEvent) => void) | undefined;
  /** For a sub-agent: the change tracker of the session that owns the conversation. */
  changes?: FileChanges | undefined;
  /** Offered to hooks as `HookContext.runAgent`. */
  runAgent?: HookContext['runAgent'];
  /** What the session is for, e.g. build, explore or ask: saved, and stamped on each run. */
  intent?: string | undefined;
  /**
   * Notes the git commit the session starts from (for `heaw eval add --from-session`), and links
   * the commits its runs make, so sessions can be traced to the changes they produced.
   */
  trackGit?: boolean | undefined;
  /**
   * When a run changed files and ran no command after its last change, send the agent back once
   * to check its work before it finishes (for projects without a `beforeStop` hook of their own).
   */
  remindToVerify?: boolean | undefined;
  /** How hard the model thinks, for models that reason. Default: the provider's. */
  reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
}

export interface SendOptions {
  signal?: AbortSignal | undefined;
}

export interface CompactOptions {
  /** What the summary should focus on. */
  instructions?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** What `compact` did. */
export interface CompactionReport {
  method: 'tool-results' | 'summary';
  beforeTokens: number;
  afterTokens: number;
  usage: Usage;
  costUsd?: number;
}

/** One conversation with an agent. History accumulates across `send` calls. */
export class Session {
  readonly id: string;
  readonly agentId: string;
  readonly parentAgentId: string | undefined;
  readonly messages: Message[] = [];
  readonly permissions: PermissionPolicy;
  readonly #system: () => string;
  readonly #limits: RunLimits;
  readonly #hooks: HookRunner;
  readonly #meter = new ContextMeter();
  readonly #compactAt: number | false;
  readonly #resumed: boolean;
  readonly #workspace: Workspace;
  readonly #observe: ((event: EngineEvent) => void) | undefined;
  readonly #retry: RetryPolicy;
  readonly #tools: ToolRuntime;
  readonly #pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
  readonly #store: SessionStore | undefined;
  readonly #beforeRun: (() => Promise<void>) | undefined;
  readonly #cwd: string;
  readonly #changes: FileChanges;
  readonly #ownsChanges: boolean;
  readonly #runAgent: HookContext['runAgent'];
  /** Told to the model with the next input, e.g. that files were rewound. */
  readonly #notes: string[] = [];
  readonly #intent: string | undefined;
  readonly #trackGit: boolean;
  #git: SessionHeader['git'];
  /** Whether the current run ran commands, which may have made commits. */
  #ranCommands = false;
  readonly #stats: UsageStats;
  readonly #remindToVerify: boolean;
  #reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  /** In plan mode: the mode and effort to go back to. */
  #planSaved: { mode: PermissionMode; effort: 'low' | 'medium' | 'high' | undefined } | undefined;
  /** The current run was reminded already: once per run is enough. */
  #reminded = false;
  /** Building an approved plan: a run that stops with steps open is sent back (#planReminder). */
  #building = false;
  /** The plan was approved during the current run, or before it (`/plan go`). */
  #buildApproved = false;
  /** Steps done when the run started, and when the agent was last sent back to the plan. */
  #stepsAtStart = 0;
  #nudgedAt: number | undefined;
  #model: ModelClient;
  #usage: Usage;
  #costUsd: number | undefined;
  #running = false;
  /** Added to the system prompt by `sessionStart` hooks on the first run. */
  #startContext: string | undefined;
  #started = false;
  #closed = false;
  /** Saved records go through one queue, so they land in order. */
  #saving: Promise<void> = Promise.resolve();
  #saveError: Error | undefined;
  #headerSaved: boolean;

  constructor(options: SessionOptions) {
    this.id = options.id ?? createSessionId();
    this.agentId = options.agentId ?? 'main';
    this.parentAgentId = options.parentAgentId;
    this.#model = options.model;
    this.#store = options.store;
    this.#beforeRun = options.beforeRun;
    this.#cwd = options.cwd ?? options.workspace?.root ?? process.cwd();
    this.messages.push(...(options.history ?? []));
    this.#usage = options.usage ?? emptyUsage();
    this.#costUsd = options.costUsd;
    // A resumed session already has its header on disk.
    this.#headerSaved = this.messages.length > 0;
    this.#resumed = this.messages.length > 0;
    const system = options.system;
    const base = typeof system === 'function' ? system : () => system;
    this.#system = () => (this.#startContext ? `${base()}\n\n${this.#startContext}` : base());
    this.#limits = { maxTurns: DEFAULT_MAX_TURNS, ...options.limits };
    this.#hooks =
      options.hooks instanceof HookRunner ? options.hooks : new HookRunner(options.hooks);
    this.#compactAt = options.compactAt ?? DEFAULT_COMPACT_AT;
    this.#workspace = options.workspace ?? noWorkspace();
    this.#ownsChanges = !options.changes;
    this.#changes = options.changes ?? new FileChanges(this.#workspace);
    this.#runAgent = options.runAgent;
    this.#intent = options.intent;
    this.#trackGit = options.trackGit ?? false;
    this.#stats = options.stats ?? new UsageStats();
    this.#remindToVerify = options.remindToVerify ?? false;
    this.#reasoningEffort = options.reasoningEffort;
    this.#observe = options.observe;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.permissions =
      options.permissions instanceof PermissionPolicy
        ? options.permissions
        : new PermissionPolicy(options.permissions);

    const toolOption = options.tools ?? [];
    if (Array.isArray(toolOption)) {
      const names = new Set<string>();
      for (const tool of toolOption) {
        if (names.has(tool.name)) throw new Error(`Two tools are named "${tool.name}".`);
        names.add(tool.name);
      }
      if (names.size && !options.workspace) throw new Error('Tools need a workspace to act in.');
    }
    const listTools = Array.isArray(toolOption) ? () => toolOption : toolOption;
    const interactive = options.interactive ?? true;
    const requestApproval =
      options.requestApproval ??
      ((request: ApprovalRequest, signal: AbortSignal) => this.#waitForApproval(request, signal));
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- read by the getter below
    const session = this;

    this.#tools = {
      tools: () => toolMap(listTools()),
      permissions: this.permissions,
      workspace: this.#workspace,
      interactive,
      requestApproval,
      state: new Map(),
      maxOutputChars: options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
      outputDir: `.heaw/sessions/${this.id}/outputs`,
      changes: this.#changes,
      hooks: { runner: this.#hooks, context: (signal) => this.#hookContext(signal) },
      agent: {
        id: this.agentId,
        depth: options.depth ?? 0,
        // A getter: the model can change between runs (setModel).
        get model() {
          return session.#model;
        },
        tools: () => [...toolMap(listTools()).values()],
        permissions: this.permissions,
        interactive,
        requestApproval,
        hooks: this.#hooks,
        hookContext: (signal) => this.#hookContext(signal),
        changes: this.#changes,
        // Only the user's agent plans; a sub-agent switching its parent's mode would surprise.
        ...((options.depth ?? 0) === 0 && {
          plan: {
            active: () => session.inPlanMode,
            enter: () => session.enterPlanMode(),
            leave: () => session.leavePlanMode(),
            build: () => session.buildPlan(),
          },
        }),
        // Only stamps: what a tool stamps it then emits, and `record` saves it once.
        stamp: (body) => this.#event(body),
        // Sub-agent events are saved in this session's log, deltas excepted.
        record: (event) => {
          this.#notice(event);
          if (!SKIPPED_EVENTS.has(event.type)) this.#save({ type: 'event', event });
          this.#observe?.(event);
        },
      },
    };
  }

  /**
   * What another session needs to continue this conversation, e.g. one of an engine rebuilt from
   * a changed config (`/reload`): same id, history, usage and cost. File changes stay behind.
   */
  snapshot(): {
    id: string;
    history: Message[];
    usage: Usage;
    costUsd?: number;
    stats: UsageStats;
  } {
    return {
      id: this.id,
      history: [...this.messages],
      usage: this.#usage,
      ...(this.#costUsd !== undefined && { costUsd: this.#costUsd }),
      stats: this.#stats,
    };
  }

  /** Total usage of all runs in this session, including runs before a resume. */
  get usage(): Usage {
    return this.#usage;
  }

  /** Total cost in USD, or undefined when no model call could be priced. */
  get costUsd(): number | undefined {
    return this.#costUsd;
  }

  /** Model calls, and which tools fill the context (`/cost`). Sub-agents' calls included. */
  usageBreakdown(): UsageBreakdown {
    return this.#stats.breakdown();
  }

  /** The estimated size of the next request, and the input tokens the model allows. */
  contextUsage(): { tokens: number; limit: number } {
    return {
      tokens: this.#meter.measure({
        system: this.#system(),
        messages: this.messages,
        tools: this.#toolSpecs(),
      }),
      limit: usableWindow(this.#model.capabilities),
    };
  }

  #toolSpecs(): ToolSpec[] {
    return [...this.#tools.tools().values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  get model(): ModelClient {
    return this.#model;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Plan mode: read-only except `PLAN.md`, with high reasoning effort. */
  get inPlanMode(): boolean {
    return this.#planSaved !== undefined;
  }

  /**
   * Enters plan mode (`/plan`, or the agent with `start_plan`): the agent can read everything
   * and write only `PLAN.md`, and thinks harder. Takes effect from the next tool call or model
   * call, so it can start in the middle of a run.
   */
  enterPlanMode(): void {
    this.#planSaved ??= { mode: this.permissions.mode, effort: this.#reasoningEffort };
    this.#building = false;
    this.permissions.setMode('read-only');
    for (const tool of ['write_file', 'edit_file']) {
      this.permissions.allowForSession(tool, { value: PLAN_FILE, type: 'path' });
    }
    this.#reasoningEffort = 'high';
  }

  /** Back to the mode and effort from before plan mode; false when it was off. */
  leavePlanMode(): boolean {
    const saved = this.#planSaved;
    if (!saved) return false;
    this.permissions.setMode(saved.mode);
    this.#reasoningEffort = saved.effort;
    this.#planSaved = undefined;
    return true;
  }

  /**
   * The user approved `PLAN.md` (`finish_plan`, `/plan go`): until its steps are all ticked, a
   * run that made progress on it and stops is sent back once to go on with the next step.
   */
  buildPlan(): void {
    this.#building = true;
    this.#buildApproved = true;
  }

  /** Continues another session's plan mode or plan build, e.g. after `/reload`. */
  continuePlan(previous: Session): void {
    if (previous.inPlanMode) this.enterPlanMode();
    else this.#building = previous.buildingPlan;
  }

  /** Whether the session is building an approved plan that still has open steps. */
  get buildingPlan(): boolean {
    return this.#building;
  }

  /** How hard the model thinks; undefined: the provider's default. */
  get reasoningEffort(): 'low' | 'medium' | 'high' | undefined {
    return this.#reasoningEffort;
  }

  /** Changes how hard the model thinks from the next model call on, e.g. high for planning. */
  setReasoningEffort(effort: 'low' | 'medium' | 'high' | undefined): void {
    this.#reasoningEffort = effort;
  }

  /** Switches the model for the next runs; the history stays. */
  setModel(model: ModelClient): void {
    this.#model = model;
  }

  /** Sends one user input and streams everything the engine does until the run ends. */
  async *send(input: string, options: SendOptions = {}): AsyncGenerator<EngineEvent, RunResult> {
    if (this.#running) {
      throw new Error('This session is already running. Wait for the current run to end.');
    }
    this.#running = true;
    try {
      await this.#beforeRun?.();
      yield* this.#start(options.signal);
      if (this.#ownsChanges) this.#changes.startRun(input);
      const base = await this.#gitBase();
      const started = Date.now();
      this.#ranCommands = false;
      this.#reminded = false;
      this.#nudgedAt = undefined;
      this.#stepsAtStart = this.#building ? await this.#planProgress() : 0;
      const notes = this.#notes.splice(0).map(
        (note) => `[${note}]

`,
      );
      const result = yield* runLoop({
        agentId: this.agentId,
        model: this.#model,
        system: this.#system,
        messages: this.messages,
        input: notes.join('') + input,
        limits: this.#limits,
        retry: this.#retry,
        tools: this.#tools,
        signal: options.signal,
        stamp: (body) => this.#stamp(body),
        onMessage: (message) => this.#save({ type: 'message', timestamp: Date.now(), message }),
        onCompact: (messages) => this.#saveCompaction(messages),
        hooks: this.#hooks,
        hookContext: (signal) => this.#hookContext(signal),
        meter: this.#meter,
        compactAt: this.#compactAt,
        intent: this.#intent,
        beforeEnd: () => this.#commitLinks(base, started),
        stopCheck: async () => this.#verifyReminder() ?? (await this.#planReminder()),
        reasoningEffort: () => this.#reasoningEffort,
      });
      this.#usage = addUsage(this.#usage, result.usage);
      if (result.costUsd !== undefined) this.#costUsd = (this.#costUsd ?? 0) + result.costUsd;

      await this.#saving;
      if (this.#saveError) {
        const { message } = this.#saveError;
        this.#saveError = undefined;
        yield {
          type: 'error',
          error: { name: 'SessionSaveError', message: `Could not save the session: ${message}` },
          recoverable: true,
          sessionId: this.id,
          agentId: this.agentId,
          timestamp: Date.now(),
        };
      }
      return result;
    } finally {
      this.#running = false;
      this.#buildApproved = false;
    }
  }

  /** Tells the model something with the next input, e.g. that heaw stopped its commands. */
  tell(note: string): void {
    this.#notes.push(note);
  }

  /** Runs whose file tools changed files, oldest first; what `rewind` can undo. */
  fileChanges(): ChangedRun[] {
    return this.#changes.runs();
  }

  /**
   * Undoes the file changes of the last `runs` runs that changed files (`/rewind`): files are
   * put back as they were, and files those runs created are removed. Only changes made with file
   * tools are undone, not those of commands. The model is told with the next input.
   */
  async rewind(runs = 1): Promise<RewindReport> {
    if (this.#running) throw new Error('Wait for the current run to end before rewinding.');
    const report = await this.#changes.rewind(runs);
    if (report.restored.length) {
      this.#notes.push(
        `The user undid your file changes from the last ${report.runs.length === 1 ? 'run' : `${report.runs.length} runs`}: ` +
          `${report.restored.join(', ')} are back as they were before. Read files again before changing them.`,
      );
    }
    return report;
  }

  /**
   * Shortens the history now (`/compact`): summarizes older turns, keeping the most recent ones.
   * Returns undefined when there is too little history to shorten.
   */
  async compact(options: CompactOptions = {}): Promise<CompactionReport | undefined> {
    if (this.#running) throw new Error('Wait for the current run to end before compacting.');
    this.#running = true;
    try {
      const signal = options.signal ?? new AbortController().signal;
      const result = await compactHistory({
        messages: this.messages,
        model: this.#model,
        meter: this.#meter,
        request: { system: this.#system(), tools: this.#toolSpecs() },
        trigger: 'manual',
        target: 0,
        instructions: options.instructions,
        hooks: this.#hooks,
        hookContext: this.#hookContext(signal),
        signal,
      });
      if (!result) return undefined;
      this.messages.splice(0, this.messages.length, ...result.messages);
      this.#saveCompaction(this.messages);
      this.#usage = addUsage(this.#usage, result.usage);
      const cost = costOf(result.usage, this.#model.capabilities.pricing);
      if (cost !== undefined) this.#costUsd = (this.#costUsd ?? 0) + cost;
      const { method, beforeTokens, afterTokens } = result;
      this.#stamp({ type: 'compaction', trigger: 'manual', method, beforeTokens, afterTokens });
      this.#stamp({
        type: 'usage',
        usage: result.usage,
        model: this.#model.id,
        ...(cost !== undefined && { costUsd: cost }),
      });
      for (const failure of result.failures) this.#stamp(hookFailureEvent(failure));
      await this.#saving;
      return {
        method,
        beforeTokens,
        afterTokens,
        usage: result.usage,
        ...(cost !== undefined && { costUsd: cost }),
      };
    } finally {
      this.#running = false;
    }
  }

  /**
   * Ends the session: runs `sessionEnd` hooks (only for a session that ran) and waits for the
   * log to be saved. Returns the hooks that failed.
   */
  async close(): Promise<HookFailure[]> {
    if (this.#closed) return [];
    this.#closed = true;
    let failures: HookFailure[] = [];
    if (this.#started) {
      const context = this.#hookContext(new AbortController().signal);
      ({ failures } = await this.#hooks.sessionEnd(context, this.#usage, this.#costUsd));
    }
    await this.#saving;
    return failures;
  }

  /**
   * Runs one tool directly, without the model (docs/DESIGN.md §7): the same validation,
   * permissions and hooks as a model's call. Its events are saved like a run's.
   */
  async callTool(
    name: string,
    args: unknown,
    options: SendOptions = {},
  ): Promise<{ output: string; status: ToolStatus }> {
    if (this.#running) throw new Error('Wait for the current run to end before calling a tool.');
    this.#running = true;
    try {
      const call = { type: 'tool-call' as const, id: `direct-${randomUUID()}`, name, args };
      const signal = options.signal ?? new AbortController().signal;
      const events = executeToolCalls([call], this.#tools, (body) => this.#stamp(body), signal);
      let status: ToolStatus = 'error';
      for (;;) {
        const step = await events.next();
        if (step.done) return { output: step.value[0]!.output, status };
        if (step.value.type === 'tool.end') status = step.value.status;
      }
    } finally {
      this.#running = false;
    }
  }

  /** Resolves once everything recorded so far is saved. */
  flush(): Promise<void> {
    return this.#saving;
  }

  /** Runs `sessionStart` hooks before the first run. */
  async *#start(signal: AbortSignal | undefined): AsyncGenerator<EngineEvent> {
    if (this.#started) return;
    this.#started = true;
    if (!this.#hooks.has('sessionStart')) return;
    const context = this.#hookContext(signal ?? new AbortController().signal);
    const result = await this.#hooks.sessionStart(context, this.#resumed);
    this.#startContext = result.context;
    for (const failure of result.failures) yield this.#stamp(hookFailureEvent(failure));
  }

  #hookContext(signal: AbortSignal): HookContext {
    return {
      sessionId: this.id,
      agentId: this.agentId,
      model: this.#model.id,
      workspace: this.#workspace,
      signal,
      ...(this.#runAgent && { runAgent: this.#runAgent }),
    };
  }

  #event(body: EngineEventBody): EngineEvent {
    return {
      ...body,
      sessionId: this.id,
      agentId: this.agentId,
      ...(this.parentAgentId !== undefined && { parentAgentId: this.parentAgentId }),
      timestamp: Date.now(),
    };
  }

  /**
   * The commit a run starts from, to tell which commits it made. The first run of a new session
   * also records it (with whether there were uncommitted changes) in the header. Only read when
   * the agent can run commands, which are what make commits.
   */
  async #gitBase(): Promise<{ head: string | undefined } | undefined> {
    if (!this.#trackGit) return undefined;
    if (!this.#headerSaved && !this.#git) {
      this.#git = await gitState(this.#workspace);
      return this.#git && { head: this.#git.head };
    }
    const tools = [...this.#tools.tools().values()];
    if (!tools.some((tool) => tool.kind === 'execute')) return undefined;
    const head = await gitHead(this.#workspace);
    return head === null ? undefined : { head };
  }

  /** Links to the commits the run made, if it ran commands. */
  async #commitLinks(
    base: { head: string | undefined } | undefined,
    since: number,
  ): Promise<EngineEventBody[]> {
    if (!base || !this.#ranCommands) return [];
    const commits = await commitsSince(this.#workspace, base.head, since);
    return commits.map(({ hash, subject }) => ({
      type: 'link',
      kind: 'commit',
      ref: hash,
      title: subject,
    }));
  }

  #notice(event: EngineEvent): void {
    this.#stats.add(event);
    if (event.type === 'tool.end' && this.#tools.tools().get(event.tool)?.kind === 'execute') {
      this.#ranCommands = true;
      if (event.status === 'ok' || event.status === 'error') this.#changes.ranCommand();
    }
  }

  #verifyReminder(): string | undefined {
    if (!this.#remindToVerify || this.#reminded || !this.#canRunCommands()) return undefined;
    // Notes, docs and heaw's own files (memory) have nothing to check.
    const files = this.#changes.unchecked.filter((file) => !NOTHING_TO_CHECK.test(file));
    if (!files.length) return undefined;
    this.#reminded = true;
    const listed =
      files.slice(0, 5).join(', ') + (files.length > 5 ? `, and ${files.length - 5} more` : '');
    return (
      `You changed ${listed} and ran no command after that, so nothing has checked those changes. ` +
      'Before you finish, verify your work the way this project does (its tests, type check, ' +
      'linter or build) and fix what fails. If it cannot be checked, say so in your answer.'
    );
  }

  /**
   * Models tend to stop after each step of a plan to report and ask whether to go on, though the
   * user approved the whole plan. A run that started the build or ticked a step and then stops
   * with steps still open is sent back once per step; an agent that stops again without
   * progress is waiting for the user on purpose, and is left alone. Progress is ticked steps,
   * and completed todo items: models track steps in either.
   */
  async #planReminder(): Promise<string | undefined> {
    if (!this.#building) return undefined;
    const steps = await readPlanSteps(this.#workspace);
    if (!steps?.open.length) {
      this.#building = false;
      return undefined;
    }
    const progress = await this.#planProgress();
    const progressed = progress > this.#stepsAtStart;
    if ((!progressed && !this.#buildApproved) || this.#nudgedAt === progress) return undefined;
    this.#nudgedAt = progress;
    const count = steps.open.length;
    return (
      `${PLAN_FILE} still has ${count} open step${count === 1 ? '' : 's'}; the next is: ` +
      `${steps.open[0]} Tick each step in ${PLAN_FILE} as soon as it is done (it is how the user ` +
      'follows the build). The user approved the whole plan, so go on with it now, step after ' +
      'step, without asking whether to continue. Stop only when a step shows the plan is wrong ' +
      'or you need something only the user can give; then say so in a sentence or two.'
    );
  }

  /** Ticked steps of the plan plus completed todo items. */
  async #planProgress(): Promise<number> {
    const steps = await readPlanSteps(this.#workspace);
    return (steps?.done ?? 0) + completedTodos(this.#tools.state);
  }

  /**
   * Whether some command could run: someone can approve one, the mode allows them, or allow rules
   * name some. A reminder to verify that no command could follow only wastes turns.
   */
  #canRunCommands(): boolean {
    const tools = [...this.#tools.tools().values()].filter((tool) => tool.kind === 'execute');
    if (!tools.length) return false;
    if (this.#tools.interactive) return true;
    return tools.some(
      (tool) =>
        this.permissions.check(tool, undefined).decision === 'allow' ||
        this.permissions.allowRulesFor(tool.name).length > 0,
    );
  }

  /** Stamps, saves and observes an event of this session. */
  #stamp(body: EngineEventBody): EngineEvent {
    const event = this.#event(body);
    this.#notice(event);
    // Deltas are not saved: the complete message follows as a `message` record.
    if (!SKIPPED_EVENTS.has(event.type)) this.#save({ type: 'event', event });
    this.#observe?.(event);
    return event;
  }

  /** The log is append-only, so a compaction is saved as the history that replaces the old one. */
  #saveCompaction(messages: Message[]): void {
    this.#save({ type: 'compaction', timestamp: Date.now(), messages: [...messages] });
  }

  #save(record: SessionRecord): void {
    const store = this.#store;
    if (!store) return;
    const records: SessionRecord[] = [];
    if (!this.#headerSaved) {
      this.#headerSaved = true;
      records.push({
        type: 'session',
        version: 1,
        id: this.id,
        createdAt: new Date().toISOString(),
        cwd: this.#cwd,
        model: this.#model.id,
        ...(this.#intent && { intent: this.#intent }),
        ...(this.#git && { git: this.#git }),
      });
    }
    records.push(record);
    this.#saving = this.#saving
      .then(() => store.append(this.id, records))
      .catch((error: unknown) => {
        this.#saveError ??= error instanceof Error ? error : new Error('unknown error');
      });
  }

  /** Answers an `approval.request` event. The run continues once it is answered. */
  approve(requestId: string, decision: ApprovalDecision): void {
    const resolve = this.#pendingApprovals.get(requestId);
    if (!resolve) throw new Error(`No pending approval request with id ${requestId}.`);
    this.#pendingApprovals.delete(requestId);
    resolve(decision);
  }

  #waitForApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pendingApprovals.delete(request.requestId);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.#pendingApprovals.set(request.requestId, (decision) => {
        signal.removeEventListener('abort', onAbort);
        resolve(decision);
      });
    });
  }
}

/** By name; the first tool with a name wins if a later source repeats it. */
function toolMap(tools: Tool[]): ReadonlyMap<string, Tool> {
  const map = new Map<string, Tool>();
  for (const tool of tools) if (!map.has(tool.name)) map.set(tool.name, tool);
  return map;
}

/** Stands in when a session has no tools; never called because there is nothing to call it. */
function noWorkspace(): Workspace {
  const fail = () => {
    throw new Error('This session has no workspace.');
  };
  return {
    kind: 'none',
    root: '',
    shell: 'none',
    resolve: fail,
    displayPath: (path) => path,
    readFile: fail,
    writeFile: fail,
    removeFile: fail,
    stat: fail,
    list: fail,
    exec: fail,
    ripgrep: fail,
    dispose: () => Promise.resolve(),
  };
}

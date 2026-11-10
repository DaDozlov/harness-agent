import type { AgentDefinition } from './agents/definitions.js';
import {
  type CreateSubagentSession,
  DEFAULT_MAX_DEPTH,
  delegateTool,
  type SubagentSettings,
} from './agents/subagents.js';
import { currentEnvironment, formatEnvironment } from './core/environment.js';
import type { EngineEvent, StopReason } from './core/events.js';
import { formatGitSummary, gitSummary } from './core/git.js';
import { type HookAgentResult, HookRunner, type Hooks } from './core/hooks.js';
import { formatInstructions, type InstructionFile } from './core/instructions.js';
import { folderContextHooks } from './config/folders.js';
import { type RunLimits, unknownPriceMessage } from './core/loop.js';
import type { ModelCapabilities, ModelClient } from './core/model.js';
import { PermissionPolicy, type PermissionRules } from './core/permissions.js';
import { lastAnswer, type Message } from './core/messages.js';
import { Session } from './core/session.js';
import {
  createSessionId,
  restoreSession,
  type SessionStore,
  type SessionSummary,
} from './core/session-store.js';
import { emptyUsage, type Usage } from './core/usage.js';
import type { UsageStats } from './core/usage-stats.js';
import type { Tool, ToolStatus } from './core/tools.js';
import type { Workspace } from './core/workspace.js';
import { mcpReloadTool, mcpSearchTool } from './mcp/agent-tools.js';
import { type McpServerEntry, mcpServerUrl } from './mcp/config.js';
import { formatMcpInstructions, McpManager, type McpServerStatus } from './mcp/manager.js';
import {
  loginProblem,
  loginToMcpServer,
  McpCredentialStore,
  McpOAuthProvider,
  oauthSettingsOf,
} from './mcp/oauth.js';
import { type Env, ProviderConfigError, resolveModel } from './providers/registry.js';
import type { ProviderSettings } from './providers/settings.js';
import { type HttpApi, httpRequestTool } from './tools/http.js';
import { DEFAULT_TOOLSETS, type ToolsetName, toolsFor } from './tools/index.js';
import { formatMemory, readMemory, rememberTool } from './tools/memory.js';
import { todosIn } from './tools/todo.js';
import { formatSkillsIndex, loadSkillTool, type Skill } from './skills/skills.js';
import { OtelTracer, type TelemetryOptions } from './observability/otel.js';
import { VERSION } from './version.js';
import { LocalWorkspace } from './workspace/local.js';

/**
 * The harness base prompt (docs/DESIGN.md §4.6). Each session adds tool guidance when tools are
 * enabled, the user's and project's instructions, and the environment block.
 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are heaw, an AI agent running in the user's terminal. Answer clearly and concisely. " +
  'If you are not sure about something, say so instead of guessing.';

/** How the agent plans: in plan mode when it has start_plan, in the conversation otherwise. */
const PLAN_GUIDANCE = {
  tool:
    '- Before building anything bigger than a few files or with real design choices, call ' +
    'start_plan and plan it properly; the user approves the plan before you build. Small, clear ' +
    'tasks need no plan: just do them.',
  talk:
    '- Plan before building anything bigger than a few files or with real design choices: say ' +
    'briefly what you will build and how, ask only the questions whose answers change the ' +
    'design, and wait for the go (when nobody can answer, write the plan down and follow it). ' +
    'Small, clear tasks need no plan.',
};

/**
 * How to work with the tools. The user's agent also learns how to plan (`plan`); a sub-agent
 * plans nothing, and one that cannot run commands leaves the checks to its caller.
 */
function toolGuidance(options: { plan?: keyof typeof PLAN_GUIDANCE; canRun: boolean }): string {
  return TOOL_GUIDANCE.flatMap(([line, needs]) => {
    if (needs === 'plan') return options.plan ? [PLAN_GUIDANCE[options.plan]] : [];
    if (needs === 'commands' && !options.canRun) return [];
    return [line];
  })
    .concat(options.canRun ? [] : [NO_COMMANDS])
    .join('\n');
}

const TOOL_GUIDANCE: Array<[line: string, needs?: 'plan' | 'commands']> = [
  ['You can read and change files and run commands in the working directory with your tools.'],
  ['- Look before you act: find and read the relevant files before changing them.'],
  [
    '- Before running project commands such as tests or builds, check how this project runs ' +
      'them (package.json scripts, Makefile, pyproject.toml, README).',
    'commands',
  ],
  ['- Change existing files with edit_file; use write_file for new files or full rewrites.'],
  [
    '- Make independent changes together: several changes to one file in one edit_file call ' +
      '(`edits`), and calls to different files in the same response. Every response costs a ' +
      'full model call, so one change per response is slow and expensive.',
  ],
  ['', 'plan'],
  [
    '- Build in small steps: first a minimal version that builds and has one passing test, ' +
      'then one piece at a time, running the checks after each step rather than only at the end.',
    'commands',
  ],
  [
    '- Carry a task through to the end in one go: do not stop between steps to report ' +
      'progress or to ask whether to continue. Stop early only for what only the user can ' +
      'give: a decision, access, a missing tool.',
  ],
  [
    '- Check that results are right, not only that the code runs: compare outputs with what ' +
      'you expect (values, counts, the errors that should be found).',
    'commands',
  ],
  [
    "- Verify your work, for example by running the project's tests, before saying it is done.",
    'commands',
  ],
  [
    '- Tests do not see layout. After changing a user interface, look at it if a tool lets you ' +
      '(a browser or screenshot tool); otherwise say in your report exactly what to check and ' +
      'where (which page, which part).',
  ],
  [
    '- When a check cannot run because something is missing from the environment (a tool, a ' +
      'runtime, a service), stop and tell the user what is needed; do not fake or work around it.',
    'commands',
  ],
  [
    "- Some actions need the user's approval. If one is denied, do not retry it unchanged: " +
      'adjust your approach or ask the user.',
  ],
];

const NO_COMMANDS =
  '- You cannot run commands. The agent that gave you the task runs the builds and tests, so ' +
  'do not report that you could not.';

/** A general sub-agent's role, when the calling agent gives none. */
const DEFAULT_SUBAGENT_PROMPT = 'You are a capable assistant doing a task for another agent.';

/**
 * What a sub-agent must know about its situation (docs/DESIGN.md §4.7). The same for every
 * sub-agent, so it can start their prompts (see `createSubagentSession`).
 */
const SUBAGENT_GUIDANCE =
  'You are a sub-agent. Another agent gave you one task and sees only your final message, not ' +
  'your steps. The user does not watch you work, and you cannot ask them anything. Do the task ' +
  'with your tools and stay within it. Then end with a complete, self-contained report: what ' +
  'you did or found, with file paths and line numbers where they help, and anything you could ' +
  'not do. Keep it as short as the task allows.';

/** Without it, models end one-shot runs with questions or offers nobody can answer. */
const ONE_SHOT_GUIDANCE =
  'This run is non-interactive: the user cannot reply, and actions that need approval are ' +
  'denied. Do as much of the task as your permissions allow. When the task involved changes ' +
  'or several steps, finish with what you did, how you verified it, and anything left undone; ' +
  'a simple question just gets its answer. Do not end with questions or offers.';

export interface EngineOptions {
  /** A `provider:model` string such as `azure:my-deployment`, or a ready model client. */
  model: string | ModelClient;
  /** Replaces the base prompt. Tool guidance and the environment block are still added. */
  system?: string;
  /** Where tools act. Default: a local workspace in the current directory. */
  workspace?: Workspace;
  /** Built-in toolsets to enable. Default: all (`DEFAULT_TOOLSETS`). */
  toolsets?: readonly ToolsetName[];
  /** More tools, e.g. created with `defineTool`. */
  tools?: Tool[];
  permissions?: PermissionRules;
  /** Whether approval requests are answered (see `Session.approve`). Default: `true`. */
  interactive?: boolean;
  /** Limits per run: turns (default 100), tokens, cost and minutes. */
  limits?: Partial<RunLimits>;
  /** Project hooks (docs/DESIGN.md §4.11); several sets run in order. */
  hooks?: Hooks | Hooks[];
  /** Compact when a request would use more than this share of the window (default 0.8), or never. */
  compactAt?: number | false;
  /** Where credentials are read from. Default: `process.env`. */
  env?: Env;
  /** Saves sessions so they can be resumed, e.g. a `JsonlSessionStore`. Default: not saved. */
  sessionStore?: SessionStore;
  /** Provider settings by name, as in `heaw.config.ts`. */
  providers?: Record<string, ProviderSettings>;
  /** Corrections to model capabilities, by model string. */
  models?: Record<string, Partial<ModelCapabilities>>;
  /** Instructions such as AGENTS.md files, most general first. */
  instructions?: InstructionFile[];
  /** Tell the model the git branch and uncommitted changes. Default: true when tools are enabled. */
  git?: boolean;
  /** MCP servers to connect, and how to read them again for a reload. */
  mcp?: {
    servers: McpServerEntry[];
    /** Reads the configured servers again (for `/mcp reload` and the agent's `mcp_reload`). */
    reload?: () => Promise<McpServerEntry[]>;
    /** Where OAuth logins are kept, e.g. `~/.heaw/credentials/mcp`. Without it, no logins. */
    credentialsDir?: string;
  };
  /** APIs for `http_request`, by base URL. The tool exists only when there are some. */
  http?: { apis?: Record<string, HttpApi> };
  /** Named agents for `delegate` and `runAgent`, e.g. from `.heaw/agents/`. */
  agents?: AgentDefinition[];
  /** Skills for `load_skill`, e.g. from `.heaw/skills/`. */
  skills?: Skill[];
  /** Nesting, parallelism and default limits of sub-agents. */
  subagents?: SubagentSettings;
  /** Sends OpenTelemetry traces of every run (docs/DESIGN.md §4.14). */
  telemetry?: TelemetryOptions;
  /**
   * What the sessions are for, e.g. `build`, `explore` or `ask`: saved with each session and
   * in traces, so outcomes can be measured per kind of work.
   */
  intent?: string;
  /**
   * When a run changed files and ran no command after its last change, send the agent back once
   * to check its work. Default: true, unless a `beforeStop` hook is configured (which checks).
   */
  verifyChanges?: boolean;
  /** How hard models that reason think. Default: the provider's (usually medium). */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface RunAgentOptions {
  /** More allow rules for this run; nobody is asked, so anything else that needs approval is denied. */
  allow?: string[];
  signal?: AbortSignal;
  /** Every event of the run, sub-agents' included. */
  onEvent?: (event: EngineEvent) => void;
}

export interface AgentRunResult {
  /** The agent's final answer. */
  text: string;
  stopReason: StopReason;
  usage: Usage;
  costUsd?: number;
  turns: number;
  /** Saved like any session when there is a session store, so it can be resumed. */
  sessionId: string;
}

export interface Engine {
  readonly model: ModelClient;
  readonly workspace: Workspace;
  /** Built-in, custom and currently connected MCP tools. */
  readonly tools: readonly Tool[];
  readonly sessionStore: SessionStore | undefined;
  /** Status of each MCP server. */
  mcpServers(): McpServerStatus[];
  /** Reads the MCP config again and starts, stops or restarts servers. Returns a short report. */
  reloadMcp(): Promise<string>;
  /** Called when an MCP server's status changes. Returns an unsubscribe function. */
  onMcpChange(listener: () => void): () => void;
  /**
   * Logs in to an MCP server with OAuth, then connects to it again. `onAuthorizationUrl` shows
   * the login page, e.g. opens the browser. Returns the server's new status line.
   */
  loginMcp(
    name: string,
    onAuthorizationUrl: (url: URL) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<string>;
  /** Starts a new conversation. */
  session(): Session;
  /** Continues a saved conversation, by id or a unique prefix of one. Needs a session store. */
  resume(idOrPrefix: string): Promise<Session>;
  /**
   * Continues a conversation of another engine in this one, e.g. after the config changed
   * (`/reload`): same id and history, this engine's settings.
   */
  continueSession(previous: Session): Session;
  /** Saved sessions, most recent first. Empty without a session store. */
  sessions(limit?: number): Promise<SessionSummary[]>;
  /** Creates another model client with the engine's credentials, e.g. to switch models. */
  createModel(spec: string): Promise<ModelClient>;
  /** Named agents. */
  readonly agents: readonly AgentDefinition[];
  readonly skills: readonly Skill[];
  /**
   * Runs an agent on a task without a UI (docs/DESIGN.md §7): `main` or a named agent. Nobody
   * is asked, so actions that need approval are denied unless `allow` rules permit them.
   */
  runAgent(name: string, task: string, options?: RunAgentOptions): Promise<AgentRunResult>;
  /** Calls a tool directly, without the model. Permissions apply, and nobody is asked. */
  callTool(
    name: string,
    args: unknown,
    options?: { allow?: string[]; signal?: AbortSignal },
  ): Promise<{ output: string; status: ToolStatus }>;
  /** Why sending traces failed last, if it did. */
  readonly telemetryError: string | undefined;
  /** Stops commands that are still running and MCP servers, and sends the last traces. */
  dispose(): Promise<void>;
}

export async function createEngine(options: EngineOptions): Promise<Engine> {
  const toolsets = options.toolsets ?? DEFAULT_TOOLSETS;
  const env = options.env ?? process.env;
  const apis = options.http?.apis ?? {};
  const tools = [
    ...toolsFor(toolsets),
    ...(toolsets.includes('http') && Object.keys(apis).length ? [httpRequestTool(apis, env)] : []),
    ...(options.tools ?? []),
  ];
  // Fails early on invalid rules; each session gets its own policy for its own approvals.
  new PermissionPolicy(options.permissions);
  const store = options.sessionStore;
  const ownsWorkspace = !options.workspace;
  const workspace: Workspace = options.workspace ?? new LocalWorkspace(process.cwd());
  // A container takes a moment to start; begin now so the first command does not wait for it.
  if (toolsets.includes('shell')) void workspace.prepare?.().catch(() => undefined);

  // MCP servers connect in the background; each run waits briefly for them (see beforeRun).
  const manageMcp = toolsets.includes('mcp') || (options.mcp?.servers.length ?? 0) > 0;
  const credentials = options.mcp?.credentialsDir
    ? new McpCredentialStore(options.mcp.credentialsDir)
    : undefined;
  const newMcpManager = () =>
    new McpManager({
      env,
      cwd: workspace.root,
      clientInfo: { name: 'heaw', version: VERSION },
      ...(credentials && {
        authProvider: (entry: McpServerEntry, url: URL) =>
          new McpOAuthProvider(credentials, url.href, oauthSettingsOf(entry, env)),
      }),
    });
  const mcp = manageMcp ? newMcpManager() : undefined;
  // MCP servers of agent files, by agent: started when the agent first runs, so their tools (a
  // browser's two dozen) cost the other agents nothing, and kept for its next run.
  const agentServers = new Map<string, McpManager>();
  const ownServers = async (
    definition: AgentDefinition | undefined,
  ): Promise<McpManager | undefined> => {
    if (!definition?.mcpServers?.length) return undefined;
    let servers = agentServers.get(definition.name);
    if (!servers) {
      servers = newMcpManager();
      agentServers.set(definition.name, servers);
      await servers.load(definition.mcpServers);
    }
    // Longer than for the project's servers: the agent is there for these tools, and the first
    // start may download the server (npx).
    await servers.ready(AGENT_MCP_WAIT_MS);
    return servers;
  };
  if (mcp && options.mcp) void mcp.load(options.mcp.servers);
  const reloadMcp = async (): Promise<string> => {
    if (!mcp || !options.mcp?.reload) return 'MCP servers cannot be reloaded in this setup.';
    const summary = await mcp.load(await options.mcp.reload());
    await mcp.ready(MCP_RELOAD_WAIT_MS);
    return describeMcpReload(summary, mcp.statuses());
  };
  // Only offered when the config can be read again; otherwise the tool could do nothing.
  if (mcp && toolsets.includes('mcp') && options.mcp?.reload) {
    tools.push(mcpSearchTool(), mcpReloadTool(reloadMcp));
  }
  const currentTools = () => [...tools, ...(mcp?.tools() ?? [])];

  const createModel = async (spec: string) =>
    priced(
      await resolveModel(spec, {
        env,
        providers: options.providers,
        capabilities: options.models?.[spec],
      }),
    );
  // A cost limit is only safe with a known price; better to fail now than to never stop.
  const priced = (client: ModelClient) => {
    if (options.limits?.maxCostUsd !== undefined && !client.capabilities.pricing) {
      throw new ProviderConfigError(unknownPriceMessage(client.id));
    }
    return client;
  };
  const model =
    typeof options.model === 'string' ? await createModel(options.model) : priced(options.model);
  // The task list survives compaction word for word, so the plan is never lost.
  // A copy: skills found in the folders the agent works in are added to it.
  const skills = [...(options.skills ?? [])];
  const offerSkills = () => {
    if (
      toolsets.includes('skills') &&
      skills.length &&
      !tools.some((t) => t.name === 'load_skill')
    ) {
      tools.push(loadSkillTool(skills));
    }
  };
  const hooks = new HookRunner([
    { beforeCompact: ({ messages }) => ({ preserve: latestTodoList(messages) }) },
    // AGENTS.md and skills of subfolders, e.g. an app generated into apps/web/.
    ...(toolsets.includes('fs')
      ? [
          folderContextHooks({
            skills,
            withSkills: toolsets.includes('skills'),
            onSkills: offerSkills,
          }),
        ]
      : []),
    ...[options.hooks ?? []].flat(),
  ]);
  const subagentHooks = hooks.forSubagents();
  const tracer = options.telemetry ? new OtelTracer(options.telemetry) : undefined;
  const observe = tracer && ((event: EngineEvent) => tracer.record(event));
  const agents = options.agents ?? [];
  const subagents = options.subagents ?? {};
  // Made now, so a wrong model or a missing price shows when heaw starts, not mid-task.
  const subagentModel = subagents.model ? await createModel(subagents.model) : undefined;
  /** A definition's own model, `inherit`, or the default for sub-agents (or the caller's). */
  const modelFor = async (definition: AgentDefinition | undefined, caller: ModelClient) => {
    const own = definition?.model;
    if (own === 'inherit') return caller;
    return own ? await createModel(own) : (subagentModel ?? caller);
  };
  offerSkills();
  if (toolsets.includes('agents') && (subagents.maxDepth ?? DEFAULT_MAX_DEPTH) > 0) {
    tools.push(
      delegateTool({
        agents,
        settings: subagents,
        createSession: (spec) => createSubagentSession(spec),
      }),
    );
  }
  // Read once; `remember` keeps it current, so later sessions of this engine see new notes.
  let memory = toolsets.includes('memory') ? await readMemory(workspace) : undefined;
  if (toolsets.includes('memory')) {
    tools.push(
      rememberTool((updated) => {
        memory = updated;
      }),
    );
  }
  const canRemember = (names: readonly string[] | undefined) =>
    tools.some((tool) => tool.name === 'remember') && (!names || names.includes('remember'));
  const memorySection = (canSave: boolean) => formatMemory(memory, { canSave });
  const skillsIndex = tools.some((tool) => tool.name === 'load_skill')
    ? formatSkillsIndex(skills)
    : undefined;
  const instructions = formatInstructions(options.instructions ?? []);
  const useGit = options.git ?? tools.length > 0;
  // A safety net for projects that configured no checks of their own.
  const remindToVerify =
    options.verifyChanges !== false &&
    tools.some((tool) => tool.kind === 'execute') &&
    ![options.hooks ?? []].flat().some((set) => set.beforeStop);
  // Read once: the branch and changes as the engine starts, not live.
  const git = useGit ? await gitSummary(workspace) : undefined;
  // Read per session, so a new or resumed session sees today's date.
  const environmentBlock = (session?: string) =>
    formatEnvironment({
      ...currentEnvironment(),
      cwd: workspace.root,
      ...(session && { session }),
      ...(tools.length && {
        workspace: {
          kind: workspace.kind,
          shell: workspace.shell,
          ...(workspace.description && { description: workspace.description }),
        },
      }),
      ...(git && { git: formatGitSummary(git) }),
    });
  const mcpSection = (own?: McpManager) =>
    [
      formatMcpInstructions([...(mcp?.instructions() ?? []), ...(own?.instructions() ?? [])]),
      // Without this the agent would only miss the tools, and guess why.
      ...(own?.statuses() ?? [])
        .filter((server) => server.status !== 'connected')
        .map(
          (server) =>
            `The MCP server "${server.name}" of your agent file is ${server.status}` +
            `${server.error ? `: ${server.error}` : ''}. Its tools are missing; say so in your report.`,
        ),
    ]
      .filter(Boolean)
      .join('\n\n') || undefined;

  /** The user's agent, or a named agent run with `runAgent`. */
  const newSession = (setup: SessionSetup = {}) => {
    const { definition, restored } = setup;
    const interactive = setup.interactive ?? options.interactive;
    const id = restored?.id ?? createSessionId();
    const environment = environmentBlock(id);
    const header = [
      options.system ?? DEFAULT_SYSTEM_PROMPT,
      ...(tools.length
        ? [
            toolGuidance({
              plan: tools.some((tool) => tool.name === 'start_plan') ? 'tool' : 'talk',
              canRun: true,
            }),
          ]
        : []),
      ...(interactive === false ? [ONE_SHOT_GUIDANCE] : []),
      ...(instructions ? [instructions] : []),
      ...(definition ? [definition.prompt] : []),
    ];
    const wanted = definition?.tools;
    const { own } = setup;
    const policy = new PermissionPolicy(setup.permissions ?? options.permissions);
    const restriction = {
      ...(definition?.mode && { mode: definition.mode }),
      ...(own && { own: ownedBy(own) }),
    };
    const listed = wanted
      ? () => currentTools().filter((tool) => wanted.includes(tool.name))
      : currentTools;
    return new Session({
      model: setup.model ?? model,
      // Read before each turn: MCP servers can connect or reload while a session goes on.
      system: () =>
        [...header, memorySection(canRemember(wanted)), mcpSection(own), environment, skillsIndex]
          .filter(Boolean)
          .join('\n\n'),
      workspace,
      tools: own ? () => withOwnTools(listed(), own) : listed,
      ...(mcp && { beforeRun: () => mcp.ready(MCP_STARTUP_WAIT_MS) }),
      permissions: Object.keys(restriction).length ? policy.restricted(restriction) : policy,
      interactive,
      limits: { ...options.limits, ...definition?.limits },
      // An agent a hook started runs only tool hooks, and cannot start more this way.
      hooks: setup.forHook ? subagentHooks : hooks,
      ...(!setup.forHook && { runAgent: hookRunAgent, remindToVerify }),
      ...((definition?.reasoningEffort ?? options.reasoningEffort) && {
        reasoningEffort: definition?.reasoningEffort ?? options.reasoningEffort,
      }),
      compactAt: options.compactAt,
      store,
      id,
      trackGit: useGit,
      ...((setup.intent ?? options.intent) && { intent: setup.intent ?? options.intent }),
      // Sub-agents' events reach the tracer through the session that started them.
      ...(observe && { observe }),
      ...(restored && {
        history: restored.history,
        usage: restored.usage,
        stats: restored.stats,
        costUsd: restored.costUsd,
      }),
    });
  };

  const createSubagentSession: CreateSubagentSession = async (spec) => {
    const childModel = await modelFor(spec.definition, spec.parent.model);
    const effort = spec.definition?.reasoningEffort ?? options.reasoningEffort;
    const environment = environmentBlock();
    const own = await ownServers(spec.definition);
    const usesMcp = !!own || spec.tools.some((tool) => tool.name.startsWith('mcp__'));
    const usesSkills = spec.tools.some((tool) => tool.name === 'load_skill');
    // What all sub-agents share comes first and their own role last: providers cache the start
    // of a prompt, so parallel sub-agents reuse each other's cached start.
    const shared = [
      SUBAGENT_GUIDANCE,
      ...(spec.tools.length
        ? [toolGuidance({ canRun: spec.tools.some((tool) => tool.name === 'run_command') })]
        : []),
      ...(instructions ? [instructions] : []),
    ];
    const role = `## Your role: ${spec.name}\n\n${spec.definition?.prompt || spec.instructions || DEFAULT_SUBAGENT_PROMPT}`;
    return new Session({
      model: childModel,
      system: () =>
        [
          ...shared,
          environment,
          memorySection(spec.tools.some((tool) => tool.name === 'remember')),
          usesMcp ? mcpSection(own) : undefined,
          usesSkills ? skillsIndex : undefined,
          role,
        ]
          .filter(Boolean)
          .join('\n\n'),
      workspace,
      tools: own ? () => withOwnTools(spec.tools, own) : spec.tools,
      permissions: own ? spec.permissions.restricted({ own: ownedBy(own) }) : spec.permissions,
      interactive: spec.parent.interactive,
      requestApproval: spec.parent.requestApproval,
      limits: spec.limits,
      hooks: subagentHooks,
      ...(effort && { reasoningEffort: effort }),
      compactAt: options.compactAt,
      // Same conversation: events and saved outputs stay with the parent's session.
      id: spec.parent.hookContext(spec.signal).sessionId,
      agentId: spec.agentId,
      parentAgentId: spec.parent.id,
      depth: spec.parent.depth + 1,
      // Its file changes belong to the parent's run, so a rewind undoes them too.
      ...(spec.parent.changes && { changes: spec.parent.changes }),
    });
  };

  /** `main` or a named agent, run to the end without anyone to ask. */
  const runNamed = async (
    name: string,
    task: string,
    setup: SessionSetup,
    runOptions: RunAgentOptions = {},
  ): Promise<AgentRunResult> => {
    const definition = name === 'main' ? undefined : agents.find((agent) => agent.name === name);
    if (name !== 'main' && !definition) {
      const names = ['main', ...agents.map((agent) => agent.name)].join(', ');
      throw new Error(`No agent named "${name}". Agents: ${names}.`);
    }
    const session = newSession({
      definition,
      own: await ownServers(definition),
      ...(definition?.model &&
        definition.model !== 'inherit' && { model: await createModel(definition.model) }),
      interactive: false,
      ...setup,
    });
    let end: Extract<EngineEvent, { type: 'run.end' }> | undefined;
    for await (const event of session.send(task, { signal: runOptions.signal })) {
      runOptions.onEvent?.(event);
      if (event.type === 'run.end' && event.agentId === session.agentId) end = event;
    }
    await session.close();
    return {
      text: lastAnswer(session.messages),
      stopReason: end?.stopReason ?? 'error',
      usage: end?.usage ?? emptyUsage(),
      ...(end?.costUsd !== undefined && { costUsd: end.costUsd }),
      turns: end?.turns ?? 0,
      sessionId: session.id,
    };
  };

  /** `HookContext.runAgent`: e.g. a reviewer's verdict in `beforeStop`. */
  const hookRunAgent = async (name: string, task: string): Promise<HookAgentResult> => {
    const { text, stopReason, costUsd } = await runNamed(name, task, { forHook: true });
    return { text, stopReason, ...(costUsd !== undefined && { costUsd }) };
  };

  // Allowed for one run: nobody can be asked, so they count as approvals given in advance.
  const withAllowed = (allow: string[] | undefined): PermissionRules => ({
    ...options.permissions,
    preapproved: [...(options.permissions?.preapproved ?? []), ...(allow ?? [])],
  });

  return {
    model,
    workspace,
    get tools() {
      return currentTools();
    },
    sessionStore: store,
    mcpServers: () => mcp?.statuses() ?? [],
    reloadMcp,
    onMcpChange: (listener) => mcp?.onChange(listener) ?? (() => undefined),
    async loginMcp(name, onAuthorizationUrl, signal) {
      const entry = mcp?.entry(name);
      if (!mcp || !entry) throw new Error(`No MCP server named "${name}".`);
      const problem = loginProblem(entry);
      if (problem) throw new Error(problem);
      if (!credentials) throw new Error('Logins are not available in this setup.');
      await loginToMcpServer({
        store: credentials,
        serverUrl: mcpServerUrl(entry, env).href,
        settings: oauthSettingsOf(entry, env),
        onAuthorizationUrl,
        ...(signal && { signal }),
      });
      await mcp.restart(name);
      await mcp.ready(MCP_RELOAD_WAIT_MS);
      const status = mcp.statuses().find((server) => server.name === name);
      return status ? describeMcpServer(status) : `${name}: logged in`;
    },
    session: () => newSession(),
    agents,
    skills,
    runAgent: (name, task, runOptions = {}) =>
      runNamed(name, task, { permissions: withAllowed(runOptions.allow) }, runOptions),
    async callTool(name, args, callOptions = {}) {
      const session = newSession({
        interactive: false,
        permissions: withAllowed(callOptions.allow),
      });
      const result = await session.callTool(name, args, { signal: callOptions.signal });
      await session.flush();
      return result;
    },
    continueSession: (previous) => newSession({ restored: previous.snapshot() }),
    async resume(idOrPrefix) {
      if (!store) throw new Error('Resuming needs a session store (EngineOptions.sessionStore).');
      const id = await store.resolve(idOrPrefix);
      const { header, messages, usage, costUsd, stats } = restoreSession(await store.load(id));
      return newSession({
        restored: {
          id,
          history: messages,
          usage,
          stats,
          ...(costUsd !== undefined && { costUsd }),
        },
        ...(header?.intent && { intent: header.intent }),
      });
    },
    sessions: (limit) => (store ? store.list(limit) : Promise.resolve([])),
    createModel,
    get telemetryError() {
      return tracer?.lastError;
    },
    async dispose() {
      await tracer?.shutdown();
      await Promise.all([mcp?.dispose(), ...[...agentServers.values()].map((s) => s.dispose())]);
      if (ownsWorkspace) await workspace.dispose();
    },
  };
}

interface SessionSetup {
  restored?: { id: string; history: Message[]; usage: Usage; stats: UsageStats; costUsd?: number };
  /** A named agent: its instructions, tools, mode and limits. */
  definition?: AgentDefinition | undefined;
  model?: ModelClient;
  permissions?: PermissionRules;
  interactive?: boolean;
  /** Started by a hook's `runAgent`. */
  forHook?: boolean;
  /** The MCP servers of the agent's own file, started. */
  own?: McpManager | undefined;
  /** Overrides the engine's intent, e.g. a resumed session's own. */
  intent?: string;
}

/** An agent's tools with those of its own MCP servers, which win over a project server's of the same name. */
function withOwnTools(tools: Tool[], own: McpManager): Tool[] {
  const owned = own.tools();
  const names = new Set(owned.map((tool) => tool.name));
  return [...tools.filter((tool) => !names.has(tool.name)), ...owned];
}

/** Whether a tool comes from the agent's own MCP servers, for its permissions. */
function ownedBy(own: McpManager): (toolName: string) => boolean {
  return (toolName) => own.tools().some((tool) => tool.name === toolName);
}

const TODO_MARKS = { pending: '[ ]', in_progress: '[>]', completed: '[x]' } as const;

/** The task list of the last todo_write call, as text, or undefined when there is none. */
function latestTodoList(messages: readonly Message[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const call = message.content.findLast(
      (part) => part.type === 'tool-call' && part.name === 'todo_write',
    );
    const todos = call?.type === 'tool-call' ? todosIn(call.args) : undefined;
    if (!todos) continue;
    const lines = todos.map((todo) => `${TODO_MARKS[todo.status]} ${todo.content}`);
    return `Your task list (todo_write), as you last set it:\n${lines.join('\n')}`;
  }
  return undefined;
}

/** How long a run waits for MCP servers to connect; slower ones join later. */
const MCP_STARTUP_WAIT_MS = 30_000;
const MCP_RELOAD_WAIT_MS = 60_000;
const AGENT_MCP_WAIT_MS = 120_000;

function describeMcpReload(
  summary: { started: string[]; stopped: string[] },
  statuses: McpServerStatus[],
): string {
  return [
    summary.started.length ? `Started: ${summary.started.join(', ')}.` : 'No servers started.',
    ...(summary.stopped.length ? [`Stopped: ${summary.stopped.join(', ')}.`] : []),
    ...statuses.map((server) => `- ${describeMcpServer(server)}`),
  ].join('\n');
}

/** One line per server, e.g. `github: connected (stdio, 12 tools)`. */
export function describeMcpServer(server: McpServerStatus): string {
  if (server.status === 'connected') {
    const tools = `${server.tools} tool${server.tools === 1 ? '' : 's'}`;
    return `${server.name}: connected (${server.transport}, ${tools})`;
  }
  return `${server.name}: ${server.status}${server.error ? ` — ${server.error}` : ''}`;
}

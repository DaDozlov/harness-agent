import { PERMISSION_MODES, type PermissionMode } from '../../core/permissions.js';
import { archivePlan, PLAN_FILE } from '../../core/plan.js';
import type { Session } from '../../core/session.js';
import type { UsageBreakdown } from '../../core/usage-stats.js';
import { describeMcpServer, type Engine } from '../../engine.js';
import { ProviderConfigError } from '../../providers/registry.js';
import { BUILD_INSTRUCTIONS } from '../../tools/plan.js';
import { formatCost, formatTokens } from '../format.js';
import { openBrowser } from '../open-browser.js';

export interface CommandContext {
  engine: Engine;
  session: () => Session;
  print: (text: string, tone?: 'info' | 'warning' | 'error') => void;
  newSession: () => void;
  /** Re-renders the status bar after a change to the session. */
  refresh: () => void;
  exit: () => void;
  /** Shows a login page; false when it could not. Default: the system browser. */
  openUrl?: (url: URL) => boolean | Promise<boolean>;
  /** Sends a message to the agent, as if the user had typed it (shown as the command). */
  send?: (text: string) => void;
  /** Rebuilds the engine from the config files, continuing the conversation; returns a report. */
  reload?: () => Promise<string>;
}

/** What `/setup` asks the agent to do. */
export const SETUP_PROMPT =
  'Set up the heaw harness for this project with me: load the setup-harness skill and follow it.';

/** What `/plan <task>` asks the agent to do. */
export function planPrompt(task: string): string {
  return `Plan this with me before building it: load the plan-work skill and follow it. Task: ${task}`;
}

/** What `/plan go` asks the agent to do. */
export const BUILD_PROMPT = `${PLAN_FILE} is approved. ${BUILD_INSTRUCTIONS}`;

/** What `/retro [session] [notes]` asks the agent to do. */
export function retroPrompt(args: string): string {
  const base =
    'Review how the work in a session went and turn what went wrong into lasting fixes: load ' +
    'the retro skill and follow it.';
  const [first, ...rest] = args.trim().split(/\s+/);
  // A session id looks like 20261106-100454-dstf; a prefix of one is enough.
  if (first && /^\d{8}(-[\w-]*)?$/.test(first)) {
    return `${base} Session: ${first}.${rest.length ? ` Notes: ${rest.join(' ')}` : ''}`;
  }
  return args.trim() ? `${base} Notes: ${args.trim()}` : base;
}

export interface SlashCommand {
  name: string;
  usage?: string;
  description: string;
  run: (args: string, context: CommandContext) => void | Promise<void>;
}

export const BYPASS_WARNING =
  'bypass mode: every action runs without asking. Use it only in a container or a folder you can afford to lose.';

/** In a Docker workspace, commands cannot touch the rest of the machine; files in the project still can change. */
export const BYPASS_IN_DOCKER =
  'bypass mode: every action runs without asking. Commands run in the Docker container; the project files are still changed for real.';

/** What to say when bypass mode is switched on. */
export function bypassNotice(workspaceKind: string): { text: string; tone: 'info' | 'warning' } {
  return workspaceKind === 'docker'
    ? { text: BYPASS_IN_DOCKER, tone: 'info' }
    : { text: BYPASS_WARNING, tone: 'warning' };
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show commands and keys',
    run: (_args, { print }) => print(helpText()),
  },
  {
    name: 'clear',
    description: 'Start a new conversation',
    run: (_args, { newSession }) => newSession(),
  },
  {
    name: 'model',
    usage: '[provider:model]',
    description: 'Show the model, or switch to another one',
    async run(args, { engine, session, print, refresh }) {
      if (!args) {
        print(
          `Model: ${session().model.id}. Switch with /model provider:model, e.g. /model azure:my-deployment.`,
        );
        return;
      }
      try {
        session().setModel(await engine.createModel(args));
        refresh();
        print(`Switched to ${session().model.id}. The conversation so far stays.`);
      } catch (error) {
        if (error instanceof ProviderConfigError) print(error.message, 'error');
        else throw error;
      }
    },
  },
  {
    name: 'mode',
    usage: '[mode]',
    description: `Show or switch the permission mode (${PERMISSION_MODES.join(', ')})`,
    run(args, { engine, session, print, refresh }) {
      const permissions = session().permissions;
      if (!args) {
        print(
          `Mode: ${permissions.mode}. Switch with /mode ${PERMISSION_MODES.join(' | ')}, or Shift+Tab.`,
        );
        return;
      }
      if (!PERMISSION_MODES.includes(args as PermissionMode)) {
        print(`Unknown mode "${args}". Use one of: ${PERMISSION_MODES.join(', ')}.`, 'error');
        return;
      }
      permissions.setMode(args as PermissionMode);
      refresh();
      if (args === 'bypass') {
        const notice = bypassNotice(engine.workspace.kind);
        print(notice.text, notice.tone);
      } else {
        print(`Mode: ${args}.`);
      }
    },
  },
  {
    name: 'tools',
    description: 'List the tools the agent can use',
    run(_args, { engine, print }) {
      if (!engine.tools.length) return print('No tools: the agent can only answer.');
      const width = Math.max(...engine.tools.map((tool) => tool.name.length));
      print(engine.tools.map((tool) => `${tool.name.padEnd(width)}  ${tool.kind}`).join('\n'));
    },
  },
  {
    name: 'mcp',
    usage: '[reload | login <server> | trust <server>]',
    description:
      'Show MCP servers, reload them after .mcp.json changed, log in to one, or accept its changed tools',
    async run(args, { engine, print, refresh, openUrl = openBrowser }) {
      if (args === 'reload') {
        print('Reloading MCP servers…');
        print(await engine.reloadMcp());
        refresh();
        return;
      }
      const [option, server] = args.split(/\s+/);
      if (option === 'login' && server) {
        try {
          const status = await engine.loginMcp(server, async (url) => {
            const opened = await openUrl(url);
            print(
              `${opened ? 'Log in in your browser. If it did not open, visit' : 'Log in on this page'}:\n${url.href}`,
            );
          });
          refresh();
          print(status);
        } catch (error) {
          print(`Could not log in to "${server}": ${(error as Error).message}`, 'error');
        }
        return;
      }
      if (option === 'trust' && server) {
        try {
          print(engine.trustMcp(server));
          refresh();
        } catch (error) {
          print((error as Error).message, 'error');
        }
        return;
      }
      if (args) {
        return print(
          `Unknown option "${args}". Use /mcp, /mcp reload, /mcp login <server> or /mcp trust <server>.`,
          'error',
        );
      }
      const servers = engine.mcpServers();
      if (!servers.length) {
        return print(
          'No MCP servers. Add one with heaw mcp add, or ask me to find and install one.',
        );
      }
      print(servers.map(describeMcpServer).join('\n'));
    },
  },
  {
    name: 'agents',
    description: 'List the named agents the agent can delegate to',
    run(_args, { engine, print }) {
      if (!engine.agents.length) {
        return print(
          'No named agents. Add one as .heaw/agents/<name>.md (front matter: name, description, ' +
            'and optionally tools, model, mode), or let the agent use general sub-agents.',
        );
      }
      print(
        engine.agents
          .map((agent) => {
            const details = [
              agent.model,
              agent.mode,
              agent.tools && `tools: ${agent.tools.join(', ')}`,
            ].filter(Boolean);
            const extra = details.length ? ` (${details.join(' · ')})` : '';
            return `${agent.name}${extra}: ${agent.description}`;
          })
          .join('\n'),
      );
    },
  },
  {
    name: 'skills',
    description: 'List the skills the agent can load',
    run(_args, { engine, print }) {
      if (!engine.skills.length) {
        return print(
          'No skills. Add one as .heaw/skills/<name>/SKILL.md (front matter: name, description).',
        );
      }
      print(engine.skills.map((skill) => `${skill.name}: ${skill.description}`).join('\n'));
    },
  },
  {
    name: 'permissions',
    description: 'Show the permission mode and rules',
    run(_args, { session, print }) {
      const { mode, allow, ask, deny, preapproved, sessionApprovals, sessionRules } =
        session().permissions.describe();
      const list = (rules: string[]) => (rules.length ? rules.join(', ') : 'none');
      const calls = `${sessionApprovals} call${sessionApprovals === 1 ? '' : 's'}`;
      print(
        [
          `Mode: ${mode}`,
          `Allow: ${list(allow)}`,
          `Ask: ${list(ask)}`,
          `Deny: ${list(deny)}`,
          ...(preapproved.length ? [`Allowed with --allow: ${list(preapproved)}`] : []),
          `Allowed for this session: ${[...sessionRules, calls].join(', ')}`,
        ].join('\n'),
      );
    },
  },
  {
    name: 'cost',
    description: 'Show token usage, cost and context of this conversation',
    run(_args, { session, print }) {
      const current = session();
      const { inputTokens, outputTokens, cacheReadTokens, reasoningTokens } = current.usage;
      const model = current.model.id;
      const cost =
        current.costUsd !== undefined
          ? `Cost: ${formatCost(current.costUsd)}.`
          : `Cost unknown: heaw has no price for ${model}. Set it in heaw.config.ts with ` +
            `models: { '${model}': { pricing: { input: …, output: … } } } (USD per million tokens).`;
      const context = current.contextUsage();
      const share = Math.round((context.tokens / context.limit) * 100);
      print(
        [
          `${formatTokens(inputTokens)} input tokens (${formatTokens(cacheReadTokens)} from cache) · ` +
            `${formatTokens(outputTokens)} output tokens (${formatTokens(reasoningTokens)} reasoning).`,
          cost,
          `Context: about ${formatTokens(context.tokens)} of ${formatTokens(context.limit)} tokens (${share}%). /compact frees space.`,
          ...describeBreakdown(current.usageBreakdown()),
        ].join('\n'),
      );
    },
  },
  {
    name: 'compact',
    usage: '[focus]',
    description: 'Summarize older turns to free context, optionally saying what matters',
    async run(args, { session, print, refresh }) {
      print('Compacting the conversation…');
      const report = await session().compact({ instructions: args || undefined });
      refresh();
      if (!report) return print('Nothing to compact yet: the conversation is still short.');
      const cost =
        report.costUsd === undefined ? '' : ` (the summary cost ${formatCost(report.costUsd)})`;
      print(
        `Compacted: ${formatTokens(report.beforeTokens)} → ${formatTokens(report.afterTokens)} tokens${cost}. ` +
          'Recent turns are kept as they were.',
      );
    },
  },
  {
    name: 'setup',
    usage: '[notes]',
    description: 'Have the agent set up the harness for this project with you (asks, then writes)',
    run(args, { send, print }) {
      if (!send) return print('/setup works in the chat.');
      send(args ? `${SETUP_PROMPT} Notes: ${args}` : SETUP_PROMPT);
    },
  },
  {
    name: 'plan',
    usage: '<task> | go | off',
    description: 'Plan a task first (read-only, writes PLAN.md); /plan go builds it step by step',
    async run(args, { session, send, print, refresh, engine }) {
      if (!send) return print('/plan works in the chat.');
      const current = session();
      const task = args.trim();
      if (task === 'off') {
        const was = current.leavePlanMode();
        refresh();
        return print(
          was ? `Left plan mode (${current.permissions.mode} mode).` : 'Not in plan mode.',
        );
      }
      if (task === 'go') {
        if (!(await engine.workspace.stat(PLAN_FILE))) {
          return print(`There is no ${PLAN_FILE} yet. Start with /plan <task>.`);
        }
        current.leavePlanMode();
        current.buildPlan();
        refresh();
        print(`Building ${PLAN_FILE} step by step (${current.permissions.mode} mode).`);
        return send(BUILD_PROMPT);
      }
      if (!task) {
        return print(
          current.inPlanMode
            ? `Plan mode: review ${PLAN_FILE}, then /plan go to build it or /plan off to leave.`
            : 'Usage: /plan <task>. The agent asks, writes PLAN.md, and builds it after /plan go.',
        );
      }
      current.enterPlanMode();
      refresh();
      const archived = await archivePlan(engine.workspace);
      print(
        `Plan mode: the agent reads, asks and writes only ${PLAN_FILE}, thinking harder. ` +
          'Then /plan go builds it, or /plan off leaves.' +
          (archived ? ` The previous plan is in ${archived}.` : ''),
      );
      send(planPrompt(task) + (archived ? ` (The previous plan was moved to ${archived}.)` : ''));
    },
  },
  {
    name: 'retro',
    usage: '[session] [notes]',
    description:
      'Have the agent review a session (default: this one, else the last) and propose lasting fixes',
    run(args, { send, print }) {
      if (!send) return print('/retro works in the chat.');
      send(retroPrompt(args));
    },
  },
  {
    name: 'reload',
    description: 'Apply changes to heaw.config.ts, AGENTS.md, .mcp.json, agents and skills',
    async run(_args, { reload, print, refresh }) {
      if (!reload) return print('Reloading is not available here; restart heaw instead.');
      print('Reloading the setup…');
      print(await reload());
      refresh();
    },
  },
  {
    name: 'rewind',
    usage: '[runs]',
    description: "Undo the agent's file changes from the last run (or the last n runs)",
    async run(args, { session, print }) {
      const runs = args ? Number(args) : 1;
      if (!Number.isInteger(runs) || runs < 1)
        return print('Usage: /rewind [runs], e.g. /rewind 2');
      if (!session().fileChanges().length) {
        return print('Nothing to rewind: no file changes by the file tools in this conversation.');
      }
      const report = await session().rewind(runs);
      const restored = report.restored.length ? report.restored.join(', ') : 'nothing';
      const skipped = report.skipped.length
        ? `\nNot restored (too large to keep): ${report.skipped.join(', ')}.`
        : '';
      print(
        `Rewound ${report.runs.length} run${report.runs.length === 1 ? '' : 's'}: restored ${restored}.` +
          `${skipped}\nChanges made by commands are not undone; the agent is told with your next message.`,
      );
    },
  },
  {
    name: 'exit',
    description: 'Leave the chat (the conversation is saved)',
    run: (_args, { exit }) => exit(),
  },
];

const ALIASES: Record<string, string> = { quit: 'exit', q: 'exit', '?': 'help' };

/** Commands whose name starts with what was typed after "/", for suggestions and Tab. */
export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  const typed = input.slice(1).toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(typed));
}

export async function runSlashCommand(input: string, context: CommandContext): Promise<void> {
  const [rawName = '', ...rest] = input.slice(1).trim().split(/\s+/);
  const name = ALIASES[rawName.toLowerCase()] ?? rawName.toLowerCase();
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (!command) {
    context.print(`Unknown command /${rawName}. Type /help to see the commands.`, 'error');
    return;
  }
  await command.run(rest.join(' '), context);
}

/** `/cost`'s view of where the tokens go: what fills the context, and calls made twice. */
export function describeBreakdown(breakdown: UsageBreakdown): string[] {
  if (!breakdown.modelCalls) return [];
  const lines = [
    `Model calls: ${breakdown.modelCalls}, the largest with ${formatTokens(breakdown.largestRequest)} input tokens.`,
  ];
  const tools = breakdown.tools.filter((tool) => tool.calls).slice(0, 5);
  if (tools.length) {
    const listed = tools.map((tool) => {
      const repeated = tool.repeated ? `, ${tool.repeated} repeated` : '';
      return `${tool.tool} ~${formatTokens(tool.resultTokens)} (${tool.calls} call${tool.calls === 1 ? '' : 's'}${repeated})`;
    });
    lines.push(`Tool results in the conversation: ${listed.join(' · ')}.`);
  }
  const repeated = breakdown.tools.reduce((sum, tool) => sum + tool.repeated, 0);
  if (repeated) {
    lines.push(
      `${repeated} call${repeated === 1 ? ' was' : 's were'} made before with the same arguments: ` +
        'if that keeps happening, the agent is re-reading what it already has.',
    );
  }
  return lines;
}

function helpText(): string {
  const width = Math.max(
    ...COMMANDS.map((command) => `/${command.name} ${command.usage ?? ''}`.length),
  );
  const commands = COMMANDS.map(
    (command) => `/${command.name} ${command.usage ?? ''}`.padEnd(width + 2) + command.description,
  );
  return [
    'Commands',
    ...commands,
    '',
    'Keys',
    'Enter            send',
    '\\ then Enter     new line',
    '↑ / ↓            earlier messages',
    'Tab              complete a /command',
    'Esc              interrupt the agent',
    'Shift+Tab        switch mode: default → accept-edits → read-only',
    'Ctrl+C           clear the input · interrupt · press twice to exit',
    'Ctrl+D           exit',
  ].join('\n');
}

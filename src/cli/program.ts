import { Command, InvalidArgumentError, Option } from 'commander';
import { PERMISSION_MODES } from '../core/permissions.js';
import { VERSION } from '../version.js';
import { startChat, type ChatOptions } from './chat/start.js';
import { evalAddCommand, type EvalAddOptions } from './commands/eval-add.js';
import { evalCommand, type EvalCommandOptions, evalCompareCommand } from './commands/eval.js';
import { initCommand } from './commands/init.js';
import { modelsCommand } from './commands/models.js';
import { sessionsCommand } from './commands/sessions.js';
import {
  type AddOptions,
  type InstallOptions,
  mcpAdd,
  type McpContext,
  mcpErrorMessage,
  mcpInstall,
  mcpList,
  mcpLogin,
  mcpLogout,
  mcpRemove,
  mcpSearch,
  mcpTest,
  mcpTrust,
  type Scope,
} from './commands/mcp.js';
import { defaultRunContext, runCommand, type RunCommandOptions } from './commands/run.js';

export interface ProgramOptions {
  /** See `LoadConfigOptions.packageEntry`: the running heaw, for imports in config files. */
  packageEntry?: string;
}

export function createProgram({ packageEntry }: ProgramOptions = {}): Command {
  const program = new Command()
    .name('heaw')
    .description('Harness-engineered agentic workflow: a provider-agnostic agent harness.')
    .version(VERSION)
    // Options before a subcommand belong to heaw itself, options after it to the subcommand.
    .enablePositionalOptions();

  withAgentOptions(program)
    .option('-c, --continue', 'continue the most recent conversation')
    .action(async (options: ChatOptions) => {
      process.exitCode = await startChat(options, { packageEntry });
    });

  withAgentOptions(
    program
      .command('resume')
      .description('Continue a saved conversation (pick one when no id is given)')
      .argument('[id]', 'session id, or the start of one'),
  ).action(async (id: string | undefined, options: ChatOptions) => {
    process.exitCode = await startChat({ ...options, resume: id ?? true }, { packageEntry });
  });

  withAgentOptions(
    program
      .command('run')
      .description(
        'Answer one prompt non-interactively and exit. Actions that need approval are denied ' +
          'unless allowed with --allow or --mode.',
      )
      .argument('[prompt...]', 'the prompt (read from stdin when omitted)'),
  )
    .option('--json', 'print engine events as JSON lines instead of text')
    .action(async (prompt: string[], options: RunCommandOptions) => {
      process.exitCode = await runCommand(prompt, options, { ...defaultRunContext, packageEntry });
    });

  program
    .command('init')
    .description('Set up heaw in the current directory: heaw.config.ts, AGENTS.md, .env.example')
    .option('-m, --model <provider:model>', 'model to put in heaw.config.ts (default: $HEAW_MODEL)')
    .action(async (options: { model?: string }) => {
      process.exitCode = await initCommand(options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: process.stdout,
      });
    });

  program
    .command('models')
    .description('Show the model heaw would use, what it knows about it, and the providers')
    .option('-m, --model <provider:model>', 'a model to look up instead')
    .action(async (options: { model?: string }) => {
      process.exitCode = await modelsCommand(options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: process.stdout,
        stderr: process.stderr,
        packageEntry,
      });
    });

  program
    .command('sessions')
    .description('List saved sessions: intent, cost, and the pull requests and commits they made')
    .option('-n, --limit <n>', 'how many, most recent first (default: 20)', parsePositiveInt)
    .option('--json', 'print them as JSON')
    .action(async (options: { limit?: number; json?: boolean }) => {
      process.exitCode = await sessionsCommand(options, {
        cwd: process.cwd(),
        stdout: process.stdout,
      });
    });

  const evals = program
    .command('eval')
    .description('Run, create and compare eval cases (docs/evals.md)');
  withAgentOptions(
    evals
      .command('run', { isDefault: true })
      .description(
        'Run the eval cases in evals/ and report pass rates, tokens, cost and time (the default)',
      )
      .argument('[filter]', 'only cases whose name or file contains this'),
  )
    .option('--trials <n>', 'trials per case, instead of what each case says', parsePositiveInt)
    .option('--docker', 'run each trial in a Docker container')
    .option('--keep', 'keep the trial folders to look at afterwards')
    .option('--json', 'print the report as JSON')
    .option('--judge-model <provider:model>', 'the model that grades judge checks')
    .option('--compare <report>', 'compare with a saved report: a file, or latest')
    .action(async (filter: string | undefined, options: EvalCommandOptions) => {
      process.exitCode = await evalCommand(filter, options, { ...defaultRunContext, packageEntry });
    });
  evals
    .command('add')
    .description('Turn a saved session into a regression case, starting from its commit')
    .argument('<name>', 'the case name: evals/<name>.yaml')
    .requiredOption('--from-session <id>', 'the session, by id or a unique prefix')
    .addOption(
      new Option('--check <command>', 'a command that must succeed, e.g. "npm test" (repeatable)')
        .argParser(collect)
        .default([], 'none'),
    )
    .addOption(
      new Option('--judge <criterion>', 'a criterion for the model judge (repeatable)')
        .argParser(collect)
        .default([], 'none'),
    )
    .option('--trials <n>', 'trials (default: 3)', parsePositiveInt)
    .action(async (name: string, options: EvalAddOptions) => {
      process.exitCode = await evalAddCommand(name, options, {
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      });
    });
  evals
    .command('compare')
    .description('Compare two saved eval reports; exits 1 when a case got worse')
    .argument('<before>', 'the earlier report (.heaw/evals/*.json)')
    .argument('<after>', 'the later report')
    .action(async (before: string, after: string) => {
      process.exitCode = await evalCompareCommand(before, after, {
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      });
    });

  addMcpCommands(program, { packageEntry });

  return program;
}

function addMcpCommands(program: Command, { packageEntry }: ProgramOptions): void {
  /** Runs a command; errors the user can fix are printed without a stack trace. */
  const run = async (command: (context: McpContext) => Promise<number>) => {
    const context: McpContext = {
      cwd: process.cwd(),
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
      packageEntry,
    };
    try {
      process.exitCode = await command(context);
    } catch (error) {
      const message = mcpErrorMessage(error);
      if (message === undefined) throw error;
      context.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  };
  const scope = () =>
    new Option('--scope <scope>', 'project (.mcp.json) or personal (~/.heaw/mcp.json)')
      .choices(['project', 'personal'])
      .default('project');
  const mcp = program.command('mcp').description('Manage MCP servers (any server works)');

  mcp
    .command('add')
    .description(
      'Add an MCP server. Local: heaw mcp add <name> -- <command> [args...]. ' +
        'Remote: heaw mcp add <name> --url <url>',
    )
    .argument('<name>', 'name for the server; its tools become mcp__<name>__<tool>')
    .argument('[command...]', 'command and arguments of a local server, after --')
    .option('--url <url>', 'URL of a remote server')
    .addOption(new Option('--transport <transport>', 'remote transport').choices(['http', 'sse']))
    .option(
      '--env <KEY=VALUE>',
      'environment variable for a local server; ${VAR} reads yours (repeatable)',
      collect,
      [],
    )
    .option('--header <Name: value>', 'HTTP header for a remote server (repeatable)', collect, [])
    .option('--oauth', 'the remote server needs a login (heaw mcp login)')
    .option('--trusted', "believe the server's read-only hints (those tools need no approval)")
    .addOption(scope())
    .action(async (name: string, command: string[], options: AddOptions) => {
      await run((context) => mcpAdd(name, command, options, context));
    });

  mcp
    .command('search')
    .description('Search the official MCP Registry')
    .argument('<query...>', 'what to look for, e.g. jira or postgres')
    .action(async (query: string[]) => {
      await run((context) => mcpSearch(query.join(' '), context));
    });

  mcp
    .command('install')
    .description('Add a server from the MCP Registry, by its name from heaw mcp search')
    .argument('<name>', 'registry name, e.g. io.github.github/github-mcp-server')
    .option('--as <name>', 'local name (default: derived from the registry name)')
    .option('--remote', 'use the remote server instead of a local package, when both exist')
    .addOption(scope())
    .action(async (name: string, options: InstallOptions) => {
      await run((context) => mcpInstall(name, options, context));
    });

  mcp
    .command('list')
    .description('Connect to the configured servers and show their status')
    .action(async () => {
      await run(mcpList);
    });

  mcp
    .command('test')
    .description('Connect to one server and list its tools')
    .argument('<name>')
    .action(async (name: string) => {
      await run((context) => mcpTest(name, context));
    });

  mcp
    .command('trust')
    .description('Accept the tools a server changed or added since it was first connected')
    .argument('<name>')
    .action(async (name: string) => {
      await run((context) => mcpTrust(name, context));
    });

  mcp
    .command('login')
    .description('Log in to a remote server in the browser (servers with "oauth": true)')
    .argument('<name>')
    .action(async (name: string) => {
      await run((context) => mcpLogin(name, context));
    });

  mcp
    .command('logout')
    .description('Delete the saved login of a remote server')
    .argument('<name>')
    .action(async (name: string) => {
      await run((context) => mcpLogout(name, context));
    });

  mcp
    .command('remove')
    .description('Remove a server from .mcp.json (or ~/.heaw/mcp.json)')
    .argument('<name>')
    .addOption(
      new Option('--scope <scope>', 'where to remove it from').choices(['project', 'personal']),
    )
    .action(async (name: string, options: { scope?: Scope }) => {
      await run((context) => mcpRemove(name, options, context));
    });
}

/** Options shared by the chat, `resume` and `run`. */
function withAgentOptions(command: Command): Command {
  return command
    .option('-m, --model <provider:model>', 'model to use (default: $HEAW_MODEL)')
    .addOption(
      new Option(
        '--mode <mode>',
        'permission mode (default: from heaw.config.ts, else default)',
      ).choices(PERMISSION_MODES),
    )
    .addOption(
      new Option(
        '--allow <rule>',
        'allow matching actions, e.g. "run_command(npm test*)" (repeatable)',
      )
        .argParser(collect)
        .default([], 'none'),
    )
    .addOption(
      new Option('--deny <rule>', 'deny matching actions, e.g. "read_file(**/.env)" (repeatable)')
        .argParser(collect)
        .default([], 'none'),
    )
    .option('--no-tools', 'answer without tools')
    .option('--no-save', 'do not save the conversation in .heaw/sessions/')
    .option('--max-turns <n>', 'maximum model turns per message', parsePositiveInt)
    .option('--max-cost <usd>', 'stop a message once it has cost this much (USD)', parsePositive)
    .option('--max-minutes <n>', 'stop a message after this many minutes', parsePositive)
    .option(
      '--intent <label>',
      'what this session is for, e.g. build, explore or ask; saved with it and in traces',
    );
}

function parsePositive(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new InvalidArgumentError('Must be a positive number.');
  }
  return number;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInt(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new InvalidArgumentError('Must be a positive whole number.');
  }
  return number;
}

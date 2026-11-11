import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../../config/load.js';
import { heawHome } from '../../config/project.js';
import { describeMcpServer } from '../../engine.js';
import {
  isHttpServer,
  loadMcpServers,
  type McpServerConfig,
  type McpServerEntry,
  mcpServerUrl,
  PERSONAL_MCP_FILE,
  PROJECT_MCP_FILE,
  removeServerFromFile,
  writeServerToFile,
} from '../../mcp/config.js';
import { McpManager } from '../../mcp/manager.js';
import { MCP_PINS_FILE, McpPins } from '../../mcp/pins.js';
import {
  loginProblem,
  loginToMcpServer,
  MCP_CREDENTIALS_DIR,
  McpCredentialStore,
  McpOAuthProvider,
  oauthSettingsOf,
} from '../../mcp/oauth.js';
import {
  describeRegistryServer,
  describeSkipped,
  findRegistryServer,
  type InstallPlan,
  type InstallVariable,
  planInstall,
  RegistryError,
  type RegistryOptions,
  searchRegistry,
  suggestName,
} from '../../mcp/registry.js';
import type { Env } from '../../providers/registry.js';
import { VERSION } from '../../version.js';
import { openBrowser } from '../open-browser.js';
import { userFacingMessage } from '../setup.js';
import type { Output } from './run.js';

export interface McpContext {
  cwd: string;
  env: Env;
  stdout: Output;
  stderr: Output;
  packageEntry?: string | undefined;
  /** How the MCP Registry is reached. Default: the official registry. */
  registry?: RegistryOptions;
  /** Shows a login page; false when it could not. Default: the system browser. */
  openUrl?: (url: URL) => boolean | Promise<boolean>;
}

/** The message for an error the user can fix, such as an invalid config or no network. */
export function mcpErrorMessage(error: unknown): string | undefined {
  return userFacingMessage(error) ?? (error instanceof RegistryError ? error.message : undefined);
}

export type Scope = 'project' | 'personal';

const NAME = /^[A-Za-z0-9_-]+$/;
const CONNECT_WAIT_MS = 60_000;

/** Where `heaw mcp add` and `remove` write, by scope. */
async function locations(context: McpContext) {
  const loaded = await loadConfig({
    cwd: context.cwd,
    env: context.env,
    packageEntry: context.packageEntry,
  });
  const home = heawHome(context.env);
  return {
    loaded,
    home,
    files: {
      project: join(loaded.projectRoot, PROJECT_MCP_FILE),
      personal: join(home, PERSONAL_MCP_FILE),
    } satisfies Record<Scope, string>,
    servers: () =>
      loadMcpServers({
        projectRoot: loaded.projectRoot,
        heawHome: home,
        fromConfig: loaded.config.mcpServers,
        configFile: loaded.files.at(-1),
      }),
  };
}

export interface AddOptions {
  url?: string;
  transport?: 'http' | 'sse';
  env?: string[];
  header?: string[];
  oauth?: boolean;
  trusted?: boolean;
  scope?: Scope;
}

/** `heaw mcp add <name> -- <command> [args…]` or `heaw mcp add <name> --url <url>`. */
export async function mcpAdd(
  name: string,
  command: string[],
  options: AddOptions,
  context: McpContext,
): Promise<number> {
  if (!NAME.test(name)) {
    context.stderr.write('Use letters, digits, - and _ for the server name.\n');
    return 2;
  }
  if (!options.url && !command.length) {
    context.stderr.write(
      'Give a command for a local server, or a URL for a remote one:\n' +
        `  heaw mcp add ${name} -- npx -y <package>\n` +
        `  heaw mcp add ${name} --url https://example.com/mcp\n`,
    );
    return 2;
  }
  let config: McpServerConfig;
  try {
    config = options.url
      ? {
          ...(options.transport && { type: options.transport }),
          url: options.url,
          ...(options.header?.length && {
            headers: pairs(options.header, ':', '--header "Name: value"'),
          }),
          ...(options.oauth && { oauth: true }),
        }
      : {
          command: command[0]!,
          ...(command.length > 1 && { args: command.slice(1) }),
          ...(options.env?.length && { env: pairs(options.env, '=', '--env KEY=VALUE') }),
        };
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  if (options.trusted) config.trusted = true;

  const { files } = await locations(context);
  const file = files[options.scope ?? 'project'];
  await writeServerToFile(file, name, config);
  context.stdout.write(
    `Added "${name}" to ${shown(file, context.cwd)}. Check it with: heaw mcp test ${name}\n`,
  );
  return 0;
}

/** `heaw mcp list`: connects to every server and shows its status. */
export async function mcpList(context: McpContext): Promise<number> {
  const { servers, loaded } = await locations(context);
  const entries = await servers();
  if (!entries.length) {
    context.stdout.write(
      'No MCP servers configured. Add one with heaw mcp add, or search the registry with heaw mcp search.\n',
    );
    return 0;
  }
  const manager = await connect(entries, context, loaded.projectRoot);
  // Read before dispose: a disposed manager has no servers left to report.
  const statuses = manager.statuses();
  await manager.dispose();
  context.stdout.write(`MCP servers (${entries.length}):\n`);
  for (const status of statuses) {
    context.stdout.write(
      `  ${describeMcpServer(status)}  [${shown(status.source, context.cwd)}]\n`,
    );
  }
  return statuses.some((status) => status.status === 'failed') ? 1 : 0;
}

/** `heaw mcp test <name>`: connects to one server and lists its tools. */
export async function mcpTest(name: string, context: McpContext): Promise<number> {
  const { servers, loaded } = await locations(context);
  const entry = (await servers()).find((candidate) => candidate.name === name);
  if (!entry) {
    context.stderr.write(`No MCP server named "${name}". See heaw mcp list.\n`);
    return 2;
  }
  const manager = await connect([entry], context, loaded.projectRoot);
  try {
    const [status] = manager.statuses();
    context.stdout.write(`${describeMcpServer(status!)}\n`);
    for (const tool of manager.tools()) {
      const description = tool.description.split('\n')[0]!.replace(/ \(MCP server "[^"]*"\)$/, '');
      context.stdout.write(`  ${tool.name}  ${description.slice(0, 100)}\n`);
    }
    const [instructions] = manager.instructions();
    if (instructions)
      context.stdout.write(`\nInstructions from the server:\n${instructions.text}\n`);
    return status?.status === 'connected' ? 0 : 1;
  } finally {
    await manager.dispose();
  }
}

/**
 * `heaw mcp trust <name>`: accepts a server's tools as they are now, releasing those held back
 * because they changed or were added since the server was first connected.
 */
export async function mcpTrust(name: string, context: McpContext): Promise<number> {
  const { servers, loaded } = await locations(context);
  const entry = (await servers()).find((candidate) => candidate.name === name);
  if (!entry) {
    context.stderr.write(`No MCP server named "${name}". See heaw mcp list.\n`);
    return 2;
  }
  const manager = await connect([entry], context, loaded.projectRoot);
  try {
    const held = manager.statuses()[0]?.held ?? [];
    if (!manager.trust(name)) {
      context.stderr.write(`${describeMcpServer(manager.statuses()[0]!)}\n`);
      return 1;
    }
    context.stdout.write(
      held.length
        ? `Accepted the changed tools of "${name}": ${held.join(', ')}.\n`
        : `"${name}" had no changed tools; its tools are pinned as they are now.\n`,
    );
    return 0;
  } finally {
    await manager.dispose();
  }
}

/** `heaw mcp remove <name>`: from `.mcp.json`, or `~/.heaw/mcp.json` with `--scope personal`. */
export async function mcpRemove(
  name: string,
  options: { scope?: Scope },
  context: McpContext,
): Promise<number> {
  const { files, servers } = await locations(context);
  const scopes: Scope[] = options.scope ? [options.scope] : ['project', 'personal'];
  for (const scope of scopes) {
    if (await removeServerFromFile(files[scope], name)) {
      context.stdout.write(`Removed "${name}" from ${shown(files[scope], context.cwd)}.\n`);
      return 0;
    }
  }
  const elsewhere = (await servers()).find((entry) => entry.name === name);
  context.stderr.write(
    elsewhere
      ? `"${name}" is defined in ${shown(elsewhere.source, context.cwd)}; remove it there.\n`
      : `No MCP server named "${name}".\n`,
  );
  return 2;
}

async function connect(entries: McpServerEntry[], context: McpContext, projectRoot: string) {
  const store = credentialStore(context);
  const manager = new McpManager({
    env: context.env,
    cwd: projectRoot,
    clientInfo: { name: 'heaw', version: VERSION },
    pins: new McpPins(join(heawHome(context.env), MCP_PINS_FILE)),
    authProvider: (entry, url) =>
      new McpOAuthProvider(store, url.href, oauthSettingsOf(entry, context.env)),
  });
  await manager.load(entries);
  await manager.ready(CONNECT_WAIT_MS);
  return manager;
}

function credentialStore(context: McpContext): McpCredentialStore {
  return new McpCredentialStore(join(heawHome(context.env), MCP_CREDENTIALS_DIR));
}

/** `heaw mcp login <name>`: logs in to a remote server in the browser and saves the tokens. */
export async function mcpLogin(name: string, context: McpContext): Promise<number> {
  const { servers, loaded } = await locations(context);
  const entry = (await servers()).find((candidate) => candidate.name === name);
  const problem = entry ? loginProblem(entry) : `No MCP server named "${name}".`;
  if (!entry || problem) {
    context.stderr.write(`${problem}\n`);
    return 2;
  }
  const store = credentialStore(context);
  const serverUrl = mcpServerUrl(entry, context.env).href;
  const open = context.openUrl ?? openBrowser;
  try {
    await loginToMcpServer({
      store,
      serverUrl,
      settings: oauthSettingsOf(entry, context.env),
      onAuthorizationUrl: async (url) => {
        const opened = await open(url);
        context.stdout.write(
          `${opened ? 'Log in in your browser. If it did not open, visit' : 'Log in on this page'}:\n  ${url.href}\n`,
        );
      },
    });
  } catch (error) {
    if (mcpErrorMessage(error)) throw error;
    context.stderr.write(`Could not log in to "${name}": ${(error as Error).message}\n`);
    return 1;
  }
  context.stdout.write(
    `Logged in to "${name}". The login is saved in ${shown(store.fileFor(serverUrl), context.cwd)}.\n`,
  );
  const manager = await connect([entry], context, loaded.projectRoot);
  const [status] = manager.statuses();
  await manager.dispose();
  context.stdout.write(`${describeMcpServer(status!)}\n`);
  return status?.status === 'connected' ? 0 : 1;
}

/** `heaw mcp logout <name>`: deletes the saved login of a remote server. */
export async function mcpLogout(name: string, context: McpContext): Promise<number> {
  const { servers } = await locations(context);
  const entry = (await servers()).find((candidate) => candidate.name === name);
  if (!entry || !isHttpServer(entry.config)) {
    context.stderr.write(
      entry
        ? `"${name}" is a local server; it has no login.\n`
        : `No MCP server named "${name}".\n`,
    );
    return 2;
  }
  const removed = await credentialStore(context).remove(mcpServerUrl(entry, context.env).href);
  context.stdout.write(removed ? `Logged out of "${name}".\n` : `Not logged in to "${name}".\n`);
  return 0;
}

/** `KEY=VALUE` or `Name: value` pairs; the value may contain the separator. */
function pairs(values: string[], separator: string, usage: string): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => {
      const index = value.indexOf(separator);
      if (index <= 0) throw new Error(`Expected ${usage}, got "${value}".`);
      return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
    }),
  );
}

/** A path relative to the current directory, or with `~` for the home directory. */
function shown(path: string, cwd: string): string {
  const fromCwd = relative(cwd, path);
  if (!fromCwd.startsWith('..')) return fromCwd || '.';
  const fromHome = relative(homedir(), path);
  return fromHome.startsWith('..') ? path : `~/${fromHome.replaceAll('\\', '/')}`;
}

/** `heaw mcp search <query>`: servers in the official MCP Registry. */
export async function mcpSearch(query: string, context: McpContext): Promise<number> {
  const servers = await searchRegistry(query, { ...context.registry, limit: 10 });
  if (!servers.length) {
    context.stdout.write(`No MCP servers found for "${query}".\n`);
    return 0;
  }
  context.stdout.write(`${servers.map((server) => describeRegistryServer(server)).join('\n')}\n`);
  context.stdout.write('\nInstall one with: heaw mcp install <name>\n');
  return 0;
}

export interface InstallOptions {
  as?: string;
  scope?: Scope;
  remote?: boolean;
}

/** `heaw mcp install <registry name>`: adds a server from the registry to .mcp.json. */
export async function mcpInstall(
  registryName: string,
  options: InstallOptions,
  context: McpContext,
): Promise<number> {
  const server = await findRegistryServer(registryName, context.registry);
  if (!server) {
    context.stderr.write(
      `No server named "${registryName}" in the MCP Registry. Find the exact name with: heaw mcp search <words>\n`,
    );
    return 2;
  }
  const name = options.as ?? suggestName(server.name);
  if (!NAME.test(name)) {
    context.stderr.write('Use letters, digits, - and _ for the server name (--as <name>).\n');
    return 2;
  }
  let plan: InstallPlan;
  try {
    plan = planInstall(server, { remote: options.remote ?? false, name });
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const { files } = await locations(context);
  const file = files[options.scope ?? 'project'];
  await writeServerToFile(file, name, plan.config);

  const runs = isHttpServer(plan.config)
    ? `URL: ${plan.config.url}`
    : `command: ${[plan.config.command, ...(plan.config.args ?? [])].join(' ')}`;
  const lines = [
    `Installed "${name}" from the MCP Registry (${plan.via}) into ${shown(file, context.cwd)}.`,
    `  ${runs}`,
  ];
  const required = plan.variables.filter((variable) => variable.required);
  const optional = plan.variables.filter((variable) => !variable.required);
  if (required.length) {
    lines.push(
      'Set these in your environment or .env before using it:',
      ...required.map((variable) => `  ${describeVariable(variable)}`),
    );
  }
  if (optional.length) {
    lines.push(
      'Optional; the default applies while unset:',
      ...optional.map((variable) => `  ${describeVariable(variable)}`),
    );
  }
  if (plan.skipped.length) {
    lines.push(
      `Left out because they are optional; to use one, add it to "${name}" in ${shown(file, context.cwd)}:`,
      ...plan.skipped.map((input) => `  ${describeSkipped(input)}`),
    );
  }
  if (isHttpServer(plan.config) && plan.config.oauth) {
    lines.push(`If it asks for a login: heaw mcp login ${name}`);
  }
  lines.push(
    'Registry entries are published by third parties: check the command above before you use it.',
    `Then try it: heaw mcp test ${name}`,
  );
  context.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function describeVariable(variable: InstallVariable): string {
  const tags = [
    ...(variable.secret ? ['secret'] : []),
    ...(variable.default ? [`default: ${variable.default}`] : []),
  ];
  const shownTags = tags.length ? ` (${tags.join(', ')})` : '';
  const description = variable.description ? ` — ${variable.description}` : '';
  return `${variable.name}${shownTags}${description}`;
}

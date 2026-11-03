import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { RunLimits } from './core/loop.js';
import type { PermissionMode } from './core/permissions.js';
import { Redactor, referencedVariables, secretsFromEnv } from './core/redact.js';
import type { Workspace } from './core/workspace.js';
import { loadInstructions } from './config/instructions.js';
import type { HeawConfig } from './config/define.js';
import { loadConfig, type LoadedConfig } from './config/load.js';
import { heawHome } from './config/project.js';
import { ConfigError } from './config/schema.js';
import { loadAgentDefinitions } from './agents/definitions.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import { loadMcpServers } from './mcp/config.js';
import { MCP_CREDENTIALS_DIR } from './mcp/oauth.js';
import { telemetryFromEnv, type TelemetryOptions } from './observability/otel.js';
import type { Env } from './providers/registry.js';
import { resolveSetting } from './providers/settings.js';
import { JsonlSessionStore } from './sessions/jsonl-store.js';
import { loadSkills } from './skills/skills.js';
import { DockerWorkspace, type DockerOptions } from './workspace/docker.js';
import { LocalWorkspace } from './workspace/local.js';
import { detectShell } from './workspace/shell.js';

export interface ProjectOptions {
  /** Where the project is looked for, as `heaw` does from there. Default: the current directory. */
  cwd?: string;
  /** Where credentials and `HEAW_*` variables are read from. Default: `process.env`. */
  env?: Env;
  /** Whether approval requests are answered (see `Session.approve`). Default: `true`. */
  interactive?: boolean;
  /** See `LoadConfigOptions.packageEntry`. */
  packageEntry?: string;

  // Overrides of the config files, as the CLI flags do.
  /** `provider:model`. Default: `HEAW_MODEL`, then the config. */
  model?: string;
  mode?: PermissionMode;
  /** Allowed in advance, like `--allow`: they also cover what the config's ask rules ask about. */
  allow?: string[];
  deny?: string[];
  /** Replace the configured limits one by one. */
  limits?: Partial<RunLimits>;
  /** `false`: no tools, MCP tools included. */
  tools?: boolean;
  /** `false`: sessions are not saved in `.heaw/sessions/`. */
  save?: boolean;
  /** What the sessions are for, e.g. `build`, `explore` or `ask` (see `EngineOptions.intent`). */
  intent?: string;
}

export interface Project {
  /** For `createEngine`. */
  options: EngineOptions;
  loaded: LoadedConfig;
  /** Agent and skill files that could not be used, with why. */
  warnings: string[];
  /** A workspace like the configured one, for another folder (e.g. an eval trial). */
  createWorkspace: (root: string) => Workspace;
}

/** No model is configured anywhere. */
export class NoModelError extends Error {
  override readonly name = 'NoModelError';
}

/**
 * Engine options for a project as `heaw` sets it up: config files, AGENTS.md, agents, skills,
 * MCP servers and their logins, the configured workspace, saved sessions, redaction and
 * telemetry. Precedence, highest first: `options`, environment variables (`HEAW_MODEL`,
 * `HEAW_SHELL`), project config, personal config. Permission rules from all of them are combined.
 */
export async function loadProject(options: ProjectOptions = {}): Promise<Project> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const loaded = await loadConfig({ cwd, env, packageEntry: options.packageEntry });
  const { config, projectRoot } = loaded;

  // An empty HEAW_MODEL counts as unset.
  const model = options.model ?? (env.HEAW_MODEL?.trim() || undefined) ?? config.model;
  if (!model) {
    throw new NoModelError(
      'No model selected. Set model in heaw.config.ts (heaw init creates one), use --model provider:model, ' +
        'or set HEAW_MODEL, e.g. HEAW_MODEL=azure:my-deployment.',
    );
  }

  const docker =
    config.workspace?.type === 'docker'
      ? await dockerOptions(config.workspace, env, projectRoot)
      : undefined;
  const shell = env.HEAW_SHELL ?? config.workspace?.shell;
  const createWorkspace = (root: string): Workspace =>
    docker ? new DockerWorkspace(root, docker) : localWorkspace(root, shell, env);
  const home = heawHome(env);
  const readMcp = async (servers: HeawConfig['mcpServers']) =>
    loadMcpServers({
      projectRoot,
      heawHome: home,
      fromConfig: servers,
      configFile: loaded.files.at(-1),
    });
  const mcpServers = await readMcp(config.mcpServers);
  // Secrets the config reads, and those with secret-looking names, never reach logs or traces.
  const redactor = new Redactor(
    secretsFromEnv(env, referencedVariables([config, mcpServers.map((entry) => entry.config)])),
  );
  const redact = (text: string) => redactor.redact(text);
  const mode = options.mode ?? config.permissions?.mode;
  const save = options.save !== false && config.sessions?.save !== false;
  const [agents, skills] = await Promise.all([
    loadAgentDefinitions({ projectRoot, heawHome: home }),
    loadSkills({ projectRoot, heawHome: home }),
  ]);
  const limits = { ...config.limits, ...definedOnly(options.limits ?? {}) };

  const engineOptions: EngineOptions = {
    model,
    env,
    ...(options.interactive !== undefined && { interactive: options.interactive }),
    workspace: createWorkspace(projectRoot),
    permissions: {
      ...(mode && { mode }),
      allow: config.permissions?.allow ?? [],
      ask: config.permissions?.ask ?? [],
      preapproved: options.allow ?? [],
      deny: [...(config.permissions?.deny ?? []), ...(options.deny ?? [])],
    },
    instructions: await loadInstructions({ projectRoot, heawHome: home }),
    ...(options.tools === false
      ? { toolsets: [] }
      : config.toolsets && { toolsets: config.toolsets }),
    ...(config.tools && { tools: config.tools }),
    ...(config.http && { http: config.http }),
    ...(config.providers && { providers: config.providers }),
    ...(config.models && { models: config.models }),
    ...(Object.keys(limits).length && { limits }),
    ...(config.hooks && { hooks: config.hooks }),
    ...(agents.items.length && { agents: agents.items }),
    ...(skills.items.length && { skills: skills.items }),
    ...(config.subagents && { subagents: config.subagents }),
    ...withTelemetry(config.telemetry, env, redact),
    ...(config.context?.compactAt !== undefined && { compactAt: config.context.compactAt }),
    ...(options.intent && { intent: options.intent }),
    ...(config.verifyChanges !== undefined && { verifyChanges: config.verifyChanges }),
    ...(save && { sessionStore: new JsonlSessionStore(projectRoot, { redact }) }),
    // No tools means no MCP tools either.
    ...(options.tools !== false && {
      mcp: {
        servers: mcpServers,
        // A reload reads every config file again, heaw.config.ts included.
        reload: async () => {
          const again = await loadConfig({ cwd, env, packageEntry: options.packageEntry });
          return readMcp(again.config.mcpServers);
        },
        credentialsDir: join(home, MCP_CREDENTIALS_DIR),
      },
    }),
  };
  return {
    options: engineOptions,
    loaded,
    warnings: [...agents.problems, ...skills.problems],
    createWorkspace,
  };
}

/**
 * An engine for the project as `heaw run` would set it up, for scripts:
 * `const engine = await createProjectEngine();`. Its `dispose` also stops the workspace (e.g.
 * the Docker container). Use `loadProject` to see warnings about agent and skill files, or to
 * change the options first.
 */
export async function createProjectEngine(options: ProjectOptions = {}): Promise<Engine> {
  const project = await loadProject(options);
  const engine = await createEngine(project.options);
  const dispose = engine.dispose.bind(engine);
  return Object.assign(engine, {
    async dispose() {
      await dispose();
      await engine.workspace.dispose();
    },
  });
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/** Traces go where the standard OTEL variables say, else where heaw.config.ts says, or nowhere. */
function withTelemetry(
  config: HeawConfig['telemetry'],
  env: Env,
  redact: (text: string) => string,
): { telemetry?: TelemetryOptions } {
  const fromEnv = telemetryFromEnv(env);
  const endpoint = fromEnv?.endpoint ?? config?.endpoint;
  if (!endpoint) return {};
  const headers = Object.fromEntries(
    Object.entries(config?.headers ?? {}).map(([name, value]) => [
      name,
      resolveSetting(value, env, `telemetry.headers.${name} in heaw.config.ts`) ?? '',
    ]),
  );
  return {
    telemetry: {
      endpoint,
      headers: { ...headers, ...fromEnv?.headers },
      serviceName: fromEnv?.serviceName ?? config?.serviceName ?? 'heaw',
      captureContent: fromEnv?.captureContent ?? config?.captureContent ?? false,
      redact,
    },
  };
}

function localWorkspace(root: string, shell: string | undefined, env: Env): LocalWorkspace {
  return new LocalWorkspace(root, {
    shell: detectShell({ ...env, ...(shell && { HEAW_SHELL: shell }) }),
  });
}

/** Docker settings with their secrets read, and the commit author copied from the host's git. */
async function dockerOptions(
  config: NonNullable<HeawConfig['workspace']>,
  env: Env,
  root: string,
): Promise<DockerOptions> {
  const tokenEnv = config.git?.tokenEnv;
  if (tokenEnv && !Object.hasOwn(config.env ?? {}, tokenEnv)) {
    throw new ConfigError(
      `workspace.git.tokenEnv is "${tokenEnv}", but the container gets no such variable. ` +
        `Add it to workspace.env, e.g. env: { ${tokenEnv}: env('${tokenEnv}') }.`,
    );
  }
  const values = Object.fromEntries(
    Object.entries(config.env ?? {}).map(([name, value]) => [
      name,
      resolveSetting(value, env, `workspace.env.${name} in heaw.config.ts`) ?? '',
    ]),
  );
  return {
    ...(config.image && { image: config.image }),
    ...(config.network && { network: config.network }),
    ...(config.cpus !== undefined && { cpus: config.cpus }),
    ...(config.memory && { memory: config.memory }),
    ...(config.command && { command: config.command }),
    env: values,
    git: { ...config.git, ...(await gitAuthor(root)) },
  };
}

async function gitAuthor(root: string): Promise<{ name?: string; email?: string }> {
  const read = (key: string) =>
    new Promise<string | undefined>((resolve) => {
      execFile('git', ['config', key], { cwd: root, windowsHide: true }, (error, stdout) =>
        resolve(error ? undefined : stdout.trim() || undefined),
      );
    });
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return { ...(name && { name }), ...(email && { email }) };
}

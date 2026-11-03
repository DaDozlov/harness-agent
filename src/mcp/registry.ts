import type { McpServerConfig } from './config.js';

/** The official MCP Registry (docs/DESIGN.md §4.5). */
export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

interface Input {
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  value?: string;
  /** Placeholders like `{token}` used in `value`. */
  variables?: Placeholders;
}

type Placeholders = Record<
  string,
  { description?: string; isRequired?: boolean; isSecret?: boolean; default?: string }
>;

interface Argument extends Input {
  type: 'positional' | 'named';
  name?: string;
  valueHint?: string;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type: string };
  runtimeArguments?: Argument[];
  packageArguments?: Argument[];
  environmentVariables?: Array<Input & { name: string }>;
}

export interface RegistryRemote {
  type: string;
  url: string;
  headers?: Array<Input & { name: string }>;
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version: string;
  websiteUrl?: string;
  repository?: { url?: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

export interface RegistryOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

/** The registry could not be reached, or answered with an error. */
export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

/** Latest versions of servers matching `query`, by name and description. */
export async function searchRegistry(
  query: string,
  options: RegistryOptions & { limit?: number } = {},
): Promise<RegistryServer[]> {
  const url = new URL('/v0/servers', options.baseUrl ?? REGISTRY_URL);
  url.searchParams.set('search', query);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(options.limit ?? 10));
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new RegistryError(`Could not reach the MCP Registry at ${url.origin}: ${reason(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new RegistryError(`The MCP Registry answered HTTP ${response.status} for "${query}".`);
  }
  const body = (await response.json()) as { servers?: Array<{ server: RegistryServer }> };
  return (body.servers ?? []).map((item) => item.server);
}

/** Why a request failed: fetch hides the network error in `cause`. */
function reason(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'no answer within 15 seconds.';
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return `${cause instanceof Error ? cause.message : String(cause)}.`;
}

/** The latest version of the server with exactly this registry name. */
export async function findRegistryServer(
  name: string,
  options: RegistryOptions = {},
): Promise<RegistryServer | undefined> {
  const results = await searchRegistry(name, { ...options, limit: 30 });
  return results.find((server) => server.name.toLowerCase() === name.toLowerCase());
}

export interface InstallVariable {
  name: string;
  description: string | undefined;
  secret: boolean;
  /** False when the config falls back to `default` (or to nothing) while it is unset. */
  required: boolean;
  default?: string;
}

/** An optional input the plan left out, ready to paste into the server's entry. */
export interface SkippedInput {
  /** Runtime arguments go before the package in `args`, package arguments after it. */
  target: 'args-before-package' | 'args-after-package' | 'env' | 'headers';
  /** A piece of JSON, e.g. `"-e", "TOKEN=${GITHUB_TOKEN}"` or `"GCS_BUCKET": "${GCS_BUCKET}"`. */
  entry: string;
  description: string | undefined;
}

export interface InstallPlan {
  config: McpServerConfig;
  /** Environment variables the config reads; set them in .env. */
  variables: InstallVariable[];
  /**
   * Optional inputs that need a value of their own, e.g. a token instead of a login. In the
   * registry format an input is optional unless it is marked required.
   */
  skipped: SkippedInput[];
  /** How it runs, e.g. `npm package @scope/server@1.2.0`. */
  via: string;
}

/** What a plan collects while it reads a registry entry. */
interface Collected {
  /** Starts variable names the entry does not choose itself: `{token}` → `GITHUB_TOKEN`. */
  prefix: string;
  variables: Map<string, InstallVariable>;
  skipped: SkippedInput[];
}

const LOCAL_RUNNERS: Record<
  string,
  { command: string; spec: (pkg: RegistryPackage) => string; defaults: string[] }
> = {
  npm: { command: 'npx', spec: (pkg) => versioned(pkg, '@'), defaults: ['-y'] },
  pypi: { command: 'uvx', spec: (pkg) => versioned(pkg, '=='), defaults: [] },
  oci: { command: 'docker', spec: (pkg) => pkg.identifier, defaults: ['run', '-i', '--rm'] },
};

/**
 * Turns a registry entry into a server config. Prefers a local package (npm, then PyPI, then a
 * Docker image) unless `remote` is set. Secrets become `${NAME}` references, so they come from the
 * environment and never land in .mcp.json. `name` is the server's local name, which starts the
 * variables the entry does not name itself (default: `suggestName`).
 */
export function planInstall(
  server: RegistryServer,
  options: { remote?: boolean; name?: string } = {},
): InstallPlan {
  const remote = server.remotes?.find((candidate) =>
    ['streamable-http', 'sse'].includes(candidate.type),
  );
  const local = Object.keys(LOCAL_RUNNERS)
    .map((type) =>
      server.packages?.find(
        (pkg) => pkg.registryType === type && (pkg.transport?.type ?? 'stdio') === 'stdio',
      ),
    )
    .find(Boolean);

  const collected: Collected = {
    prefix: envName(options.name ?? suggestName(server.name)),
    variables: new Map(),
    skipped: [],
  };
  const planned =
    remote && (options.remote || !local)
      ? planRemote(remote, collected)
      : local && planLocal(local, collected);
  if (planned) {
    return { ...planned, variables: [...collected.variables.values()], skipped: collected.skipped };
  }
  const kinds = [
    ...(server.packages ?? []).map((pkg) => pkg.registryType),
    ...(server.remotes ?? []).map((r) => r.type),
  ];
  throw new Error(
    `heaw cannot run "${server.name}" yet: it is published only as ${kinds.join(', ') || 'nothing runnable'}. ` +
      'Supported: npm, PyPI and Docker packages over stdio, and remote HTTP servers.',
  );
}

type PlannedServer = Pick<InstallPlan, 'config' | 'via'>;

function planLocal(pkg: RegistryPackage, collected: Collected): PlannedServer {
  const runner = LOCAL_RUNNERS[pkg.registryType]!;
  const image = pkg.registryType === 'oci';
  const args = pkg.runtimeArguments?.length
    ? [
        ...(image ? ['run', '-i', '--rm'] : []),
        ...pkg.runtimeArguments.flatMap((arg) =>
          argumentValues(arg, 'args-before-package', collected),
        ),
      ]
    : [...runner.defaults];

  const env: Record<string, string> = {};
  for (const variable of pkg.environmentVariables ?? []) {
    const value = environmentValue(variable, image, collected);
    if (value === undefined) continue;
    env[variable.name] = value;
    // A container only sees the variables it is given.
    if (image) args.push('-e', variable.name);
  }
  args.push(
    runner.spec(pkg),
    ...(pkg.packageArguments ?? []).flatMap((arg) =>
      argumentValues(arg, 'args-after-package', collected),
    ),
  );

  const kind = image ? 'Docker image' : `${pkg.registryType} package`;
  return {
    config: { command: runner.command, args, ...(Object.keys(env).length && { env }) },
    via: `${kind} ${runner.spec(pkg)}`,
  };
}

/** The value for one environment variable, or undefined when it is optional and left out. */
function environmentValue(
  variable: Input & { name: string },
  image: boolean,
  collected: Collected,
): string | undefined {
  // Without a value of its own, it reads the variable of the same name.
  const own = variable.value === undefined;
  const raw = variable.value ?? `{${variable.name}}`;
  const placeholders = own ? { [variable.name]: variable } : variable.variables;
  const prefix = own ? undefined : collected.prefix;
  if (!needsInput(placeholders) || variable.isRequired) {
    return fill(raw, placeholders, prefix, collected.variables);
  }
  // Servers get only the variables in their config, so leaving one unset there is not enough.
  const value = fill(raw, placeholders, prefix);
  collected.skipped.push(
    image
      ? {
          target: 'args-before-package',
          entry: fragment(['-e', `${variable.name}=${value}`]),
          description: variable.description,
        }
      : {
          target: 'env',
          entry: fragment({ [variable.name]: value }),
          description: variable.description,
        },
  );
  return undefined;
}

function planRemote(remote: RegistryRemote, collected: Collected): PlannedServer {
  const headers: Record<string, string> = {};
  for (const header of remote.headers ?? []) {
    // Without a value, the whole header comes from a variable, e.g. `GITHUB_AUTHORIZATION`.
    const raw = header.value ?? `{${header.name}}`;
    const placeholders = header.value === undefined ? { [header.name]: header } : header.variables;
    // Secret headers carry the credentials, so they stay even when they are not marked required.
    if (needsInput(placeholders) && !header.isRequired && !header.isSecret) {
      collected.skipped.push({
        target: 'headers',
        entry: fragment({ [header.name]: fill(raw, placeholders, collected.prefix) }),
        description: header.description,
      });
      continue;
    }
    headers[header.name] = fill(raw, placeholders, collected.prefix, collected.variables);
  }
  // Without credentials in a header, a server that wants them asks for a login.
  const credentials = Object.values(headers).some((value) => value.includes('${'));
  return {
    config: {
      type: remote.type === 'sse' ? 'sse' : 'http',
      url: remote.url,
      ...(Object.keys(headers).length && { headers }),
      ...(!credentials && { oauth: true }),
    },
    via: `remote server ${remote.url}`,
  };
}

/** Values for one argument; optional arguments that need input of their own are left out. */
function argumentValues(
  arg: Argument,
  target: SkippedInput['target'],
  collected: Collected,
): string[] {
  const values = (value?: string) => [
    ...(arg.type === 'named' && arg.name ? [arg.name] : []),
    ...(value === undefined ? [] : [value]),
  ];
  let raw = arg.value ?? arg.default;
  let placeholders = arg.variables;
  if (raw === undefined && arg.type === 'named' && !arg.valueHint) {
    // A flag such as `--read-only`.
    if (arg.isRequired) return values();
    collected.skipped.push({ target, entry: fragment(values()), description: arg.description });
    return [];
  }
  if (raw === undefined) {
    // The value comes from a variable named after the argument, e.g. `{directory}`.
    const key = arg.valueHint ?? arg.name ?? 'value';
    raw = `{${key}}`;
    placeholders = { [key]: arg };
  }
  if (needsInput(placeholders) && !arg.isRequired) {
    const entry = fragment(values(fill(raw, placeholders, collected.prefix)));
    collected.skipped.push({ target, entry, description: arg.description });
    return [];
  }
  return values(fill(raw, placeholders, collected.prefix, collected.variables));
}

/** Whether some placeholder has no default, so someone has to provide a value. */
function needsInput(placeholders: Placeholders | undefined): boolean {
  return Object.values(placeholders ?? {}).some((input) => input.default === undefined);
}

/**
 * Turns `{token}` placeholders into references to environment variables, e.g. `${GITHUB_TOKEN}`,
 * and records each variable in `variables` when given. Without a `prefix`, keys are used as names.
 */
function fill(
  value: string,
  placeholders: Placeholders | undefined,
  prefix: string | undefined,
  variables?: Map<string, InstallVariable>,
): string {
  return value.replace(/\{([^{}\s]+)\}/g, (match, key: string) => {
    const input = placeholders?.[key];
    if (!input) return match;
    const name = prefix === undefined ? key : variableName(prefix, key);
    const optional = input.default !== undefined || input.isRequired === false;
    variables?.set(name, {
      name,
      description: input.description,
      secret: input.isSecret ?? false,
      required: !optional,
      ...(input.default !== undefined && { default: input.default }),
    });
    return optional ? `\${${name}:-${input.default ?? ''}}` : `\${${name}}`;
  });
}

/** `token` → `GITHUB_TOKEN`; a key that already starts with the prefix keeps its name. */
function variableName(prefix: string, key: string): string {
  const name = envName(key);
  return name === prefix || name.startsWith(`${prefix}_`) ? name : `${prefix}_${name}`;
}

function envName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

/** A piece of JSON to paste into `args`, `env` or `headers`. */
function fragment(value: string[] | Record<string, string>): string {
  return Array.isArray(value)
    ? value.map((item) => JSON.stringify(item)).join(', ')
    : Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`)
        .join(', ');
}

function versioned(pkg: RegistryPackage, separator: string): string {
  return pkg.version && !pkg.identifier.includes(separator, 1)
    ? `${pkg.identifier}${separator}${pkg.version}`
    : pkg.identifier;
}

/** A short local name: `io.github.github/github-mcp-server` → `github`. */
export function suggestName(registryName: string): string {
  const last = registryName.split('/').at(-1) ?? registryName;
  const trimmed = last
    .toLowerCase()
    .replace(/^mcp-server-|^server-/, '')
    .replace(/-mcp-server$|-server$|-mcp$|^mcp-/, '');
  return trimmed.replace(/[^a-z0-9_-]/g, '-') || 'server';
}

/** A few lines per server for search results, for people and for the model. */
export function describeRegistryServer(server: RegistryServer): string {
  let how: string;
  try {
    how = planInstall(server).via;
  } catch {
    how = 'not runnable by heaw';
  }
  const description = (server.description ?? server.title ?? '').replace(/\s+/g, ' ').trim();
  return `${server.name} (v${server.version}) — ${description.slice(0, 160)}\n  runs as: ${how}`;
}

const SKIPPED_TARGETS: Record<SkippedInput['target'], string> = {
  'args-before-package': 'in "args", before the package',
  'args-after-package': 'in "args", after the package',
  env: 'in "env"',
  headers: 'in "headers"',
};

/** E.g. `"GCS_BUCKET": "${GCS_BUCKET}" (in "env") — Constrain all operations to one bucket.` */
export function describeSkipped(input: SkippedInput): string {
  const description = input.description ? ` — ${input.description}` : '';
  return `${input.entry} (${SKIPPED_TARGETS[input.target]})${description}`;
}

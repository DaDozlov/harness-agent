import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../config/errors.js';
import {
  type EnvRef,
  isEnvRef,
  ProviderConfigError,
  resolveSetting,
  type Setting,
} from '../providers/settings.js';

/**
 * One MCP server, in the format many servers document for other clients (`.mcp.json`).
 * docs/DESIGN.md §4.5.
 */
export type McpServerConfig = (McpStdioServer | McpHttpServer) & McpServerOptions;

export interface McpStdioServer {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, Setting>;
  cwd?: string;
}

export interface McpHttpServer {
  /** `http` is Streamable HTTP; `sse` the older transport. Default for a `url`: http, falling back to sse. */
  type?: 'http' | 'sse';
  url: string;
  headers?: Record<string, Setting>;
  /**
   * Log in with OAuth (`heaw mcp login`). An object can preset a client registered in advance:
   * its id, secret and scopes, and the callback port registered with it.
   */
  oauth?:
    | boolean
    | { clientId?: string; clientSecret?: Setting; scopes?: string[]; callbackPort?: number };
}

export interface McpServerOptions {
  /** Only these tools (names as the server reports them). */
  includeTools?: string[];
  excludeTools?: string[];
  /** Tools the server marks read-only count as `read` (no approval in default mode). */
  trusted?: boolean;
  /** Timeout for each tool call. Default: 60. */
  timeoutSeconds?: number;
  disabled?: boolean;
}

/** A configured server and the file it came from. */
export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  source: string;
}

export function isHttpServer(config: McpServerConfig): config is McpHttpServer & McpServerOptions {
  return 'url' in config && typeof config.url === 'string';
}

const setting = z.custom<string | EnvRef>((value) => typeof value === 'string' || isEnvRef(value), {
  message: "expected text or env('NAME')",
});
const options = {
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
  trusted: z.boolean().optional(),
  timeoutSeconds: z.number().positive().optional(),
  disabled: z.boolean().optional(),
};
const stdioSchema = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), setting).optional(),
    cwd: z.string().optional(),
    ...options,
  })
  .strict();
const httpSchema = z
  .object({
    type: z.enum(['http', 'sse', 'streamable-http']).optional(),
    url: z.string().url(),
    headers: z.record(z.string(), setting).optional(),
    oauth: z
      .union([
        z.boolean(),
        z
          .object({
            clientId: z.string().optional(),
            clientSecret: setting.optional(),
            scopes: z.array(z.string()).optional(),
            callbackPort: z.number().int().min(1).max(65_535).optional(),
          })
          .strict(),
      ])
      .optional(),
    ...options,
  })
  .strict();

export const mcpServerSchema = z.custom<McpServerConfig>(
  (value) => stdioSchema.safeParse(value).success || httpSchema.safeParse(value).success,
);

/** Validates one server, with a message that names the problem. */
export function validateServer(value: unknown, where: string): McpServerConfig {
  const isHttp = typeof value === 'object' && value !== null && 'url' in value;
  const result = (isHttp ? httpSchema : stdioSchema).safeParse(value);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(server)'}: ${issue.message}`,
    );
    throw new ConfigError(
      `${where}: ${problems.join('; ')}${isHttp ? '' : ' (a server needs "command" or "url")'}`,
    );
  }
  const raw = result.data as { type?: string };
  // Some clients write "streamable-http" for the same transport.
  if (raw.type === 'streamable-http') raw.type = 'http';
  return result.data as McpServerConfig;
}

/** Reads `{ "mcpServers": { … } }` (or VS Code's `{ "servers": { … } }`) from a JSON file. */
export async function readMcpFile(path: string): Promise<McpServerEntry[]> {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const servers = serversOf(parsed);
  if (!servers) throw new ConfigError(`${path} needs an "mcpServers" object.`);
  return Object.entries(servers).map(([name, value]) => ({
    name,
    config: validateServer(value, `${path}: mcpServers.${name}`),
    source: path,
  }));
}

function serversOf(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const servers = record.mcpServers ?? record.servers;
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : undefined;
}

export const PROJECT_MCP_FILE = '.mcp.json';
export const PERSONAL_MCP_FILE = 'mcp.json';

/**
 * All configured servers: personal `~/.heaw/mcp.json`, project `.mcp.json`, then `mcpServers`
 * in heaw.config.ts. A later source replaces a server of the same name.
 */
export async function loadMcpServers(options: {
  projectRoot: string;
  heawHome: string;
  fromConfig?: Record<string, McpServerConfig> | undefined;
  configFile?: string | undefined;
}): Promise<McpServerEntry[]> {
  const byName = new Map<string, McpServerEntry>();
  const add = (entries: McpServerEntry[]) =>
    entries.forEach((entry) => byName.set(entry.name, entry));
  add(await readMcpFile(join(options.heawHome, PERSONAL_MCP_FILE)));
  add(await readMcpFile(join(options.projectRoot, PROJECT_MCP_FILE)));
  add(
    Object.entries(options.fromConfig ?? {}).map(([name, config]) => ({
      name,
      config: validateServer(config, `heaw.config.ts: mcpServers.${name}`),
      source: options.configFile ?? 'heaw.config.ts',
    })),
  );
  return [...byName.values()];
}

/** Adds or replaces a server in a JSON file, keeping everything else in it. */
export async function writeServerToFile(
  path: string,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  const current = existsSync(path)
    ? (JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)
    : {};
  const key = 'servers' in current && !('mcpServers' in current) ? 'servers' : 'mcpServers';
  const servers = (current[key] as Record<string, unknown> | undefined) ?? {};
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...current, [key]: { ...servers, [name]: config } }, null, 2)}\n`,
  );
}

/** The URL of a remote server, with `${VAR}` references filled in. */
export function mcpServerUrl(
  entry: McpServerEntry,
  environment: Record<string, string | undefined>,
): URL {
  if (!isHttpServer(entry.config)) throw new Error(`"${entry.name}" is not a remote server.`);
  return new URL(expandValue(entry.config.url, environment, `mcpServers.${entry.name}.url`));
}

/** Removes a server from a JSON file. Returns false when it was not there. */
export async function removeServerFromFile(path: string, name: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const current = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const key = current.mcpServers ? 'mcpServers' : 'servers';
  if (!current[key] || !(name in current[key])) return false;
  delete current[key][name];
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
  return true;
}

/**
 * Replaces `${VAR}` and `${VAR:-default}` with environment values, and resolves `env()`.
 * `where` names the setting in errors.
 */
export function expandValue(
  value: Setting,
  environment: Record<string, string | undefined>,
  where: string,
): string {
  const text = isEnvRef(value) ? (resolveSetting(value, environment, where) ?? '') : value;
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => {
      const found = environment[name];
      if (found !== undefined && found !== '') return found;
      if (fallback !== undefined) return fallback;
      throw new ProviderConfigError(
        `${where} uses \${${name}}, which is not set. Set it in your environment or in .env.`,
      );
    },
  );
}

export function expandRecord(
  values: Record<string, Setting> | undefined,
  environment: Record<string, string | undefined>,
  where: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [
      key,
      expandValue(value, environment, `${where}.${key}`),
    ]),
  );
}

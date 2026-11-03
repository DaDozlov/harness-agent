import { resolve } from 'node:path';
import {
  type CallToolResult,
  Client,
  type OAuthClientProvider,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool as McpTool,
  type Transport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Env } from '../providers/registry.js';
import {
  expandRecord,
  expandValue,
  isHttpServer,
  type McpServerEntry,
  mcpServerUrl,
} from './config.js';

export type McpStatus = 'connecting' | 'connected' | 'failed' | 'needs-login' | 'disabled';

const CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const STDERR_KEPT = 2_000;
/** E.g. `Error: Cannot find module …`, `ModuleNotFoundError: …` or `npm error code E404`. */
const ERROR_LINE = /^(\w*(Error|Exception)\b|(npm )?error\b)/i;

export interface McpConnectionOptions {
  env: Env;
  /** Where stdio servers start, and what relative `cwd` settings are relative to. */
  cwd: string;
  clientInfo: { name: string; version: string };
  /** Supplies OAuth for servers configured with `oauth`, given the server's expanded URL. */
  authProvider?: ((entry: McpServerEntry, url: URL) => OAuthClientProvider | undefined) | undefined;
  onChange?: (() => void) | undefined;
}

/** One configured MCP server: connects, lists its tools, calls them. */
export class McpConnection {
  readonly entry: McpServerEntry;
  status: McpStatus = 'connecting';
  error: string | undefined;
  tools: McpTool[] = [];
  instructions: string | undefined;
  transport: 'stdio' | 'http' | 'sse';
  readonly #options: McpConnectionOptions;
  #client: Client | undefined;
  #stderr = '';

  constructor(entry: McpServerEntry, options: McpConnectionOptions) {
    this.entry = entry;
    this.#options = options;
    this.transport = isHttpServer(entry.config)
      ? entry.config.type === 'sse'
        ? 'sse'
        : 'http'
      : 'stdio';
  }

  get name(): string {
    return this.entry.name;
  }

  async connect(): Promise<void> {
    if (this.entry.config.disabled) {
      this.#set('disabled');
      return;
    }
    try {
      await this.#connectWithFallback();
      this.tools = await listAllTools(this.#client!);
      this.instructions = this.#client!.getInstructions()?.trim() || undefined;
      this.#set('connected');
    } catch (error) {
      await this.close();
      const oauth = isHttpServer(this.entry.config) && this.entry.config.oauth;
      const refused = error instanceof UnauthorizedError || httpStatusOf(error) === 401;
      if (refused && oauth) {
        this.#set(
          'needs-login',
          `needs a login: heaw mcp login ${this.name}, or /mcp login ${this.name} in the chat`,
        );
      } else if (refused) {
        this.#set(
          'failed',
          'the server refused the credentials (HTTP 401): check its token or headers, or set "oauth": true if it uses a login',
        );
      } else {
        this.#set('failed', describe(error) + this.#stderrTail());
      }
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    if (!this.#client || this.status !== 'connected') {
      throw new Error(
        `MCP server "${this.name}" is not connected${this.error ? `: ${this.error}` : ''}.`,
      );
    }
    const timeout = (this.entry.config.timeoutSeconds ?? DEFAULT_CALL_TIMEOUT_MS / 1000) * 1000;
    return this.#client.callTool({ name, arguments: args }, { signal, timeout });
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }

  async #connectWithFallback(): Promise<void> {
    const { config } = this.entry;
    if (!isHttpServer(config)) return this.#connectOver(this.#stdioTransport());
    if (config.type === 'sse') return this.#connectOver(this.#httpTransport('sse'));
    try {
      await this.#connectOver(this.#httpTransport('http'));
    } catch (error) {
      // Older servers only speak SSE. An explicit type, or an auth problem, is not a reason to try.
      if (config.type === 'http' || error instanceof UnauthorizedError) throw error;
      await this.close();
      try {
        await this.#connectOver(this.#httpTransport('sse'));
        this.transport = 'sse';
      } catch {
        // Neither worked: the Streamable HTTP error says more than the fallback's.
        throw error;
      }
    }
  }

  async #connectOver(transport: Transport): Promise<void> {
    const client = new Client(this.#options.clientInfo);
    this.#client = client;
    client.onclose = () => {
      if (this.status !== 'connected') return;
      this.tools = [];
      this.#set('failed', `the server stopped${this.#stderrTail()}`);
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${CONNECT_TIMEOUT_MS / 1000} s`)),
        CONNECT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([client.connect(transport), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #stdioTransport(): Transport {
    const config = this.entry.config as Extract<McpServerEntry['config'], { command: string }>;
    const where = `mcpServers.${this.name}`;
    const transport = new StdioClientTransport({
      command: expandValue(config.command, this.#options.env, `${where}.command`),
      args: (config.args ?? []).map((arg, index) =>
        expandValue(arg, this.#options.env, `${where}.args.${index}`),
      ),
      // Only a basic environment plus what the config names: servers are other people's code.
      env: {
        ...getDefaultEnvironment(),
        ...expandRecord(config.env, this.#options.env, `${where}.env`),
      },
      cwd: resolve(this.#options.cwd, config.cwd ?? '.'),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-STDERR_KEPT);
    });
    return transport;
  }

  #httpTransport(kind: 'http' | 'sse'): Transport {
    const config = this.entry.config as Extract<McpServerEntry['config'], { url: string }>;
    const url = mcpServerUrl(this.entry, this.#options.env);
    const headers = expandRecord(
      config.headers,
      this.#options.env,
      `mcpServers.${this.name}.headers`,
    );
    const authProvider = config.oauth ? this.#options.authProvider?.(this.entry, url) : undefined;
    const options = { requestInit: { headers }, ...(authProvider && { authProvider }) };
    return kind === 'http'
      ? new StreamableHTTPClientTransport(url, options)
      : new SSEClientTransport(url, options);
  }

  /** What a failed server printed: its error message when one stands out, else the last lines. */
  #stderrTail(): string {
    const lines = this.#stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const error = lines.find((line) => ERROR_LINE.test(line));
    const shown = (error ? [error] : lines.slice(-3)).join(' | ');
    return shown ? ` (server output: ${shown})` : '';
  }

  #set(status: McpStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.#options.onChange?.();
  }
}

async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return `the command was not found (${error.message})`;
  const status = httpStatusOf(error);
  if (status) {
    const text = (error as { data?: { text?: unknown } }).data?.text;
    const body = typeof text === 'string' ? text.trim() : '';
    return `the server answered HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`;
  }
  return error.message;
}

/** The HTTP status behind an SDK error: on `data.status`, or only in the message. */
function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { data?: { status?: unknown } } | undefined)?.data?.status;
  if (typeof status === 'number') return status;
  const match = /\(HTTP (\d{3})\)/.exec(error instanceof Error ? error.message : '');
  return match ? Number(match[1]) : undefined;
}

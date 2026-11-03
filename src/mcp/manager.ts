import type { Tool } from '../core/tools.js';
import type { McpServerEntry } from './config.js';
import { McpConnection, type McpConnectionOptions, type McpStatus } from './connection.js';
import { toolsOf } from './tools.js';

export interface McpServerStatus {
  name: string;
  status: McpStatus;
  error: string | undefined;
  tools: number;
  transport: 'stdio' | 'http' | 'sse';
  source: string;
}

export interface McpLoadSummary {
  started: string[];
  stopped: string[];
  unchanged: string[];
}

/**
 * All MCP servers of an engine (docs/DESIGN.md §4.5). Servers connect in parallel and never
 * block each other; tools and instructions reflect whatever is connected right now.
 */
export class McpManager {
  readonly #options: Omit<McpConnectionOptions, 'onChange'>;
  readonly #connections = new Map<string, McpConnection>();
  readonly #pending = new Set<Promise<void>>();
  readonly #listeners = new Set<() => void>();

  constructor(options: Omit<McpConnectionOptions, 'onChange'>) {
    this.#options = options;
  }

  /**
   * Makes the running servers match `entries`: stops removed or changed servers, starts new or
   * changed ones (without waiting for them), keeps the rest.
   */
  async load(entries: McpServerEntry[]): Promise<McpLoadSummary> {
    const summary: McpLoadSummary = { started: [], stopped: [], unchanged: [] };
    const wanted = new Map(entries.map((entry) => [entry.name, entry]));

    for (const [name, connection] of this.#connections) {
      const next = wanted.get(name);
      if (next && JSON.stringify(next.config) === JSON.stringify(connection.entry.config)) {
        summary.unchanged.push(name);
        continue;
      }
      this.#connections.delete(name);
      await connection.close();
      if (!next) summary.stopped.push(name);
    }
    for (const entry of entries) {
      if (this.#connections.has(entry.name)) continue;
      this.#start(entry);
      summary.started.push(entry.name);
    }
    this.#changed();
    return summary;
  }

  /** The configured server with this name. */
  entry(name: string): McpServerEntry | undefined {
    return this.#connections.get(name)?.entry;
  }

  /** Connects to a server again, e.g. after a login. Returns false when there is no such server. */
  async restart(name: string): Promise<boolean> {
    const connection = this.#connections.get(name);
    if (!connection) return false;
    await connection.close();
    this.#start(connection.entry);
    this.#changed();
    return true;
  }

  /** Resolves when every server that is starting has connected or failed, or after the timeout. */
  async ready(timeoutMs: number): Promise<void> {
    if (!this.#pending.size) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.#pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Engine tools from all connected servers. */
  tools(): Tool[] {
    return [...this.#connections.values()]
      .filter((connection) => connection.status === 'connected')
      .flatMap(toolsOf);
  }

  /** Usage instructions servers sent when they connected. */
  instructions(): Array<{ server: string; text: string }> {
    return [...this.#connections.values()].flatMap((connection) =>
      connection.status === 'connected' && connection.instructions
        ? [{ server: connection.name, text: connection.instructions }]
        : [],
    );
  }

  statuses(): McpServerStatus[] {
    return [...this.#connections.values()].map((connection) => ({
      name: connection.name,
      status: connection.status,
      error: connection.error,
      tools: connection.status === 'connected' ? toolsOf(connection).length : 0,
      transport: connection.transport,
      source: connection.entry.source,
    }));
  }

  /** Called whenever a server's status changes, e.g. to re-render a status line. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map((connection) => connection.close()));
  }

  #start(entry: McpServerEntry): void {
    const connection = new McpConnection(entry, {
      ...this.#options,
      onChange: () => this.#changed(),
    });
    this.#connections.set(entry.name, connection);
    const connecting = connection.connect().finally(() => this.#pending.delete(connecting));
    this.#pending.add(connecting);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** The system prompt section for server instructions, or undefined when there are none. */
export function formatMcpInstructions(
  instructions: Array<{ server: string; text: string }>,
): string | undefined {
  if (!instructions.length) return undefined;
  return [
    'These MCP servers are connected and explained how to use their tools:',
    ...instructions.map(
      ({ server, text }) =>
        `<mcp-server-instructions server="${server}">\n${text}\n</mcp-server-instructions>`,
    ),
  ].join('\n\n');
}

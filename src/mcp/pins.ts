import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tool as McpTool } from '@modelcontextprotocol/client';

/**
 * The tools each MCP server had when the user first connected it (docs/DESIGN.md §4.5). A
 * server's tool descriptions go into the agent's prompt, so a server that changes them later
 * (an update, a compromised package, a remote server) can direct the agent. A tool whose
 * description or arguments changed, and a tool that was not there, are held back until the
 * user accepts them (`heaw mcp trust <server>`).
 *
 * Kept per user, outside any project: a project's own files are what it would change.
 */
/** The pins' file in the personal folder (`~/.heaw`). */
export const MCP_PINS_FILE = 'mcp-pins.json';

export class McpPins {
  readonly #file: string;
  #data: Record<string, Record<string, string>> | undefined;

  constructor(file: string) {
    this.#file = file;
  }

  /**
   * The tools to hold back. A server seen for the first time gets its tools pinned: the user
   * configured it, which is when it is trusted.
   */
  review(key: string, tools: readonly McpTool[]): Set<string> {
    const data = this.#load();
    const pinned = data[key];
    if (!pinned) {
      this.trust(key, tools);
      return new Set();
    }
    return new Set(
      tools.filter((tool) => pinned[tool.name] !== fingerprint(tool)).map((tool) => tool.name),
    );
  }

  /** Accepts the tools as they are now. */
  trust(key: string, tools: readonly McpTool[]): void {
    const data = this.#load();
    data[key] = Object.fromEntries(tools.map((tool) => [tool.name, fingerprint(tool)]));
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Without a place to keep them, the tools are still used; they are checked next time.
    }
  }

  #load(): Record<string, Record<string, string>> {
    if (this.#data) return this.#data;
    try {
      this.#data = JSON.parse(readFileSync(this.#file, 'utf8')) as Record<
        string,
        Record<string, string>
      >;
    } catch {
      this.#data = {};
    }
    return this.#data;
  }
}

/** What the agent learns from a tool: its description, arguments and hints. */
export function fingerprint(tool: McpTool): string {
  const seen = {
    description: tool.description ?? '',
    title: tool.title ?? '',
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? {},
  };
  return createHash('sha256').update(JSON.stringify(seen)).digest('hex').slice(0, 32);
}

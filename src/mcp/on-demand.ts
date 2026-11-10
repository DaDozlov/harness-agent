import { z } from 'zod';
import type { Message } from '../core/messages.js';
import type { Tool } from '../core/tools.js';
import { defineTool } from '../tools/define.js';

/**
 * MCP tools on demand (docs/DESIGN.md §4.5). A server such as GitHub's brings dozens of tools,
 * and every tool's schema goes with every model call: thousands of tokens paid on each turn for
 * tools the task never needs. On demand, the system prompt lists their names, and the agent
 * loads the ones it needs with `load_tools`.
 */
export type McpToolsMode = 'auto' | 'on-demand' | 'all';

/** Above this many MCP tools, `auto` loads them on demand. */
export const ON_DEMAND_ABOVE = 20;

export function isOnDemand(mode: McpToolsMode, toolCount: number): boolean {
  return mode === 'on-demand' || (mode === 'auto' && toolCount > ON_DEMAND_ABOVE);
}

/**
 * The system prompt's list, one line per tool. All of them, loaded or not: the list stays the
 * same as tools are loaded, so the cached start of the prompt stays valid.
 */
export function onDemandSection(tools: readonly Tool[]): string | undefined {
  if (!tools.length) return undefined;
  return [
    '## MCP tools on demand',
    '',
    'These tools are not loaded yet, so they are not among the tools you can call. When the task needs some of them, call `load_tools` with their names first; they can be called from your next step and stay loaded for this conversation.',
    '',
    ...tools.map((tool) => `- ${tool.name}: ${firstSentence(tool.description)}`),
  ].join('\n');
}

function firstSentence(text: string): string {
  const clean = text
    .replace(/\s*\(MCP server "[^"]*"\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = /^(.{1,140}?[.!?])(?:\s|$)/.exec(clean)?.[1];
  if (sentence) return sentence;
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

/** `load_tools` for one conversation: what it loads goes into `loaded`. */
export function loadToolsTool(available: () => readonly Tool[], loaded: Set<string>): Tool {
  return defineTool({
    name: 'load_tools',
    description:
      'Load MCP tools listed under "MCP tools on demand" in your instructions, so you can call ' +
      'them from your next step. Give their exact names; they stay loaded for this conversation.',
    kind: 'read',
    parameters: z.object({
      names: z
        .array(z.string())
        .min(1)
        .describe('Exact tool names from the list, e.g. mcp__github__create_issue'),
    }),
    run({ names }) {
      const known = new Set(available().map((tool) => tool.name));
      const found = names.filter((name) => known.has(name));
      const missing = names.filter((name) => !known.has(name));
      for (const name of found) loaded.add(name);
      if (!found.length) {
        return {
          output: `No such tools: ${missing.join(', ')}. Use names from the list.`,
          isError: true,
        };
      }
      return [
        `Loaded: ${found.join(', ')}. Call them from your next step.`,
        ...(missing.length ? [`Not found: ${missing.join(', ')}.`] : []),
      ].join('\n');
    },
  });
}

/** The tools a restored conversation had loaded, from its `load_tools` calls. */
export function loadedIn(messages: readonly Message[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.name !== 'load_tools') continue;
      const wanted = (part.args as { names?: unknown } | undefined)?.names;
      if (Array.isArray(wanted)) names.push(...wanted.filter((name) => typeof name === 'string'));
    }
  }
  return names;
}

import { z } from 'zod';
import type { Tool } from '../core/tools.js';
import { defineTool } from '../tools/define.js';
import {
  describeRegistryServer,
  describeSkipped,
  type InstallPlan,
  planInstall,
  type RegistryServer,
  searchRegistry,
  suggestName,
} from './registry.js';

/**
 * Lets the agent apply its own changes to `.mcp.json` (docs/DESIGN.md §4.5). Starting servers
 * runs other people's code, so this is an `execute` tool: it asks in default mode.
 */
export function mcpReloadTool(reload: () => Promise<string>): Tool {
  return defineTool({
    name: 'mcp_reload',
    description:
      'Reload MCP servers after .mcp.json (project) or ~/.heaw/mcp.json changed: starts new or ' +
      'changed servers, stops removed ones, and reports each server with its status and tool ' +
      'count. New tools can be used from your next step. Servers needing secrets read them from ' +
      'environment variables; tell the user which ones to set rather than asking for the values.',
    kind: 'execute',
    parameters: z.object({}),
    run: () => reload(),
  });
}

/**
 * Lets the agent find servers in the MCP Registry, with entries it can add to .mcp.json. A query
 * to a fixed public registry that changes nothing, so it counts as `read`; installing still takes
 * the approvals for writing .mcp.json and for mcp_reload.
 */
export function mcpSearchTool(search: typeof searchRegistry = searchRegistry): Tool {
  return defineTool({
    name: 'mcp_search',
    description:
      'Search the official MCP Registry for MCP servers (integrations such as GitHub, Jira, ' +
      'Notion or databases). Returns matching servers with a ready .mcp.json entry and the ' +
      'environment variables each one needs. To install one: add the entry under "mcpServers" ' +
      'in .mcp.json at the project root (keep the servers already there), then call mcp_reload. ' +
      'Registry entries come from third parties: tell the user what you install and which ' +
      'variables to set; never ask for secret values in the chat.',
    kind: 'read',
    parameters: z.object({
      query: z.string().describe('What to look for, e.g. "jira" or "postgres"'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum results (default 5)'),
    }),
    async run({ query, limit = 5 }) {
      const servers = await search(query, { limit });
      if (!servers.length) return `No MCP servers found for "${query}".`;
      return servers.map(describeForAgent).join('\n\n');
    },
  });
}

function describeForAgent(server: RegistryServer): string {
  const name = suggestName(server.name);
  let plan: InstallPlan;
  try {
    plan = planInstall(server, { name });
  } catch (error) {
    return `${server.name}: ${(error as Error).message}`;
  }
  const needs = plan.variables.length
    ? plan.variables
        .map((v) => `${v.name}${v.required ? '' : ' (optional)'}${v.secret ? ' (secret)' : ''}`)
        .join(', ')
    : 'nothing';
  return [
    describeRegistryServer(server),
    `  .mcp.json entry: "${name}": ${JSON.stringify(plan.config)}`,
    `  needs: ${needs}`,
    ...(plan.skipped.length
      ? [
          '  left out as optional (add to the entry only if the user wants it):',
          ...plan.skipped.map((input) => `    ${describeSkipped(input)}`),
        ]
      : []),
  ].join('\n');
}

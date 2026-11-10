import { createHash } from 'node:crypto';
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/client';
import type { ToolImage } from '../core/messages.js';
import type { Tool, ToolOutput } from '../core/tools.js';
import type { McpConnection } from './connection.js';

/**
 * `mcp__<server>__<tool>`, limited to the characters and length every provider accepts for tool
 * names (`[A-Za-z0-9_-]`, 64).
 */
export function mcpToolName(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `mcp__${clean(server)}__${clean(tool)}`;
  if (name.length <= 64) return name;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

/** Makes an MCP server's tool an engine tool. */
export function adaptMcpTool(connection: McpConnection, tool: McpTool): Tool {
  const { trusted } = connection.entry.config;
  const schema: Record<string, unknown> = {
    type: 'object',
    ...(tool.inputSchema as Record<string, unknown>),
  };
  delete schema.$schema;
  const description = tool.description ?? tool.title ?? tool.annotations?.title ?? '';

  return {
    name: mcpToolName(connection.name, tool.name),
    description: `${description}${description ? ' ' : ''}(MCP server "${connection.name}")`,
    // Servers are other people's code: only a trusted server's read-only claim is believed.
    kind: trusted && tool.annotations?.readOnlyHint ? 'read' : 'execute',
    inputSchema: schema,
    parse(args) {
      const value = args ?? {};
      return typeof value === 'object' && !Array.isArray(value)
        ? { ok: true, args: value }
        : { ok: false, error: 'Arguments must be an object.' };
    },
    async run(args, context) {
      const result = await connection.callTool(
        tool.name,
        args as Record<string, unknown>,
        context.signal,
      );
      return resultToOutput(result);
    },
  };
}

/**
 * MCP results are lists of content parts; the model gets text, with other parts described, and
 * images also as images (a model that can see gets them, see `ToolResultPart.images`).
 */
export function resultToOutput(result: CallToolResult): ToolOutput {
  const images: ToolImage[] = [];
  const parts = (result.content ?? []).map((part) => {
    switch (part.type) {
      case 'text':
        return part.text;
      case 'image':
        images.push({ mediaType: part.mimeType, data: part.data });
        return `[image, ${part.mimeType}, ${Buffer.byteLength(part.data, 'base64')} bytes]`;
      case 'audio':
        return `[audio, ${part.mimeType}]`;
      case 'resource':
        return 'text' in part.resource ? part.resource.text : `[resource ${part.resource.uri}]`;
      case 'resource_link':
        return `[link to resource ${part.uri}${part.name ? ` (${part.name})` : ''}]`;
      default:
        return JSON.stringify(part);
    }
  });
  if (!parts.length && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const output = parts.join('\n') || '(no output)';
  if (result.isError) return { output, isError: true };
  return images.length ? { output, images } : output;
}

/** The tools of one connected server, after includeTools / excludeTools. */
export function toolsOf(connection: McpConnection): Tool[] {
  const { includeTools, excludeTools } = connection.entry.config;
  return connection.tools
    .filter((tool) => !includeTools || includeTools.includes(tool.name))
    .filter((tool) => !excludeTools?.includes(tool.name))
    .map((tool) => adaptMcpTool(connection, tool));
}

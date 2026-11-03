import type { Tool } from '../core/tools.js';
import { FS_TOOLS } from './fs.js';
import { SHELL_TOOLS } from './shell.js';
import { TODO_TOOLS } from './todo.js';
import { WEB_TOOLS } from './web.js';

/** Built-in toolsets a project can switch on (docs/DESIGN.md §4.4). */
export const TOOLSETS = {
  fs: FS_TOOLS,
  shell: SHELL_TOOLS,
  web: WEB_TOOLS,
  todo: TODO_TOOLS,
  // These depend on settings and the engine (http.apis, the MCP manager, agent definitions,
  // skills, the workspace's memory file), so the engine adds them.
  http: [],
  mcp: [],
  agents: [],
  skills: [],
  memory: [],
} as const satisfies Record<string, Tool[]>;

export type ToolsetName = keyof typeof TOOLSETS;

export const DEFAULT_TOOLSETS: ToolsetName[] = [
  'fs',
  'shell',
  'web',
  'todo',
  'http',
  'mcp',
  'agents',
  'skills',
  'memory',
];

export function toolsFor(names: readonly string[]): Tool[] {
  return names.flatMap((name) => {
    if (!Object.hasOwn(TOOLSETS, name)) {
      throw new Error(`Unknown toolset "${name}". Available: ${Object.keys(TOOLSETS).join(', ')}.`);
    }
    return TOOLSETS[name as ToolsetName];
  });
}

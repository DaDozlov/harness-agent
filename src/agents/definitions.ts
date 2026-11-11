import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RunLimits } from '../core/loop.js';
import { PERMISSION_MODES, type PermissionMode } from '../core/permissions.js';
import { type McpServerEntry, validateServer } from '../mcp/config.js';

/**
 * A named agent (docs/DESIGN.md §4.7), defined in `.heaw/agents/<name>.md` (project) or
 * `~/.heaw/agents/<name>.md` (personal): YAML front matter, then its instructions.
 */
export interface AgentDefinition {
  name: string;
  /** When to use it; the calling agent chooses by this. */
  description: string;
  /** Its instructions, the body of the file. */
  prompt: string;
  /**
   * `provider:model`, or `inherit` for the calling agent's model. Default: `subagents.model` for a
   * sub-agent, else the calling agent's model.
   */
  model?: string;
  /** Which of the calling agent's tools it may use. Default: all of them. */
  tools?: string[];
  /** A stricter permission mode than the caller's, e.g. `read-only`. Never a looser one. */
  mode?: PermissionMode;
  /** How hard it thinks, for models that reason, e.g. `high` for a reviewer. Default: the config's. */
  reasoningEffort?: ReasoningEffort;
  limits?: Partial<RunLimits>;
  /**
   * How often `delegate` may start it per message of the calling agent, e.g. 2 for a reviewer:
   * a review always finds something more, and agents told to review again only once still ran
   * three rounds per message. Default: no limit.
   */
  maxRuns?: number;
  /**
   * MCP servers only this agent uses, such as a browser for a tester: started when it first runs,
   * their tools given to it besides `tools`, and allowed for it unless a deny rule says otherwise.
   */
  mcpServers?: McpServerEntry[];
  /** The file it came from. */
  source: string;
}

export interface LoadedDefinitions<T> {
  items: T[];
  /** Files that could not be used, with why; heaw starts anyway. */
  problems: string[];
}

const NAME = /^[\w-]+$/;

type ReasoningEffort = 'low' | 'medium' | 'high';
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/** Tool names in agent files written for Claude Code, so they work here unchanged. */
const TOOL_ALIASES: Record<string, string> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  LS: 'list_dir',
  Glob: 'glob',
  Grep: 'grep',
  Bash: 'run_command',
  WebFetch: 'web_fetch',
  TodoWrite: 'todo_write',
  Task: 'delegate',
  Skill: 'load_skill',
};

/** Splits YAML front matter (between `---` lines) from the Markdown body. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const content = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { data: {}, body: content };
  const data: unknown = parseYaml(match[1]!) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('the front matter must be "key: value" lines');
  }
  return { data: data as Record<string, unknown>, body: content.slice(match[0].length) };
}

/** Personal definitions first, then the project's, which win by name. */
export async function loadAgentDefinitions(dirs: {
  projectRoot: string;
  heawHome: string;
}): Promise<LoadedDefinitions<AgentDefinition>> {
  const problems: string[] = [];
  const byName = new Map<string, AgentDefinition>();
  for (const dir of [join(dirs.heawHome, 'agents'), join(dirs.projectRoot, '.heaw', 'agents')]) {
    for (const file of await markdownFiles(dir)) {
      try {
        const { definition, notes } = parseAgentDefinition(await readFile(file, 'utf8'), file);
        byName.set(definition.name, definition);
        problems.push(...notes.map((note) => `${file}: ${note}`));
      } catch (error) {
        problems.push(`${file}: ${(error as Error).message}; skipped.`);
      }
    }
  }
  return { items: [...byName.values()], problems };
}

/** Reads one definition. Throws when it is unusable; `notes` are things it worked around. */
export function parseAgentDefinition(
  text: string,
  source: string,
): { definition: AgentDefinition; notes: string[] } {
  const { data, body } = parseFrontmatter(text);
  const notes: string[] = [];
  const name = stringField(data, 'name') ?? basename(source, '.md');
  if (!NAME.test(name)) throw new Error(`the name "${name}" may only use letters, digits, - and _`);
  const description = stringField(data, 'description');
  if (!description) {
    throw new Error('it has no description, so no agent could know when to use it');
  }

  const model = stringField(data, 'model');
  const usableModel = model === 'inherit' || model?.includes(':') ? model : undefined;
  if (model && !usableModel) {
    notes.push(
      `model "${model}" is not provider:model, so it is ignored (subagents.model or the calling agent's model is used).`,
    );
  }

  const mode = stringField(data, 'mode');
  if (mode && !PERMISSION_MODES.includes(mode as PermissionMode)) {
    throw new Error(`mode must be one of ${PERMISSION_MODES.join(', ')}, not "${mode}"`);
  }
  const effort = stringField(data, 'reasoningEffort');
  if (effort && !REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
    throw new Error(
      `reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}, not "${effort}"`,
    );
  }

  const limits: Partial<RunLimits> = {};
  for (const key of ['maxTurns', 'maxTokens', 'maxCostUsd', 'maxMinutes'] as const) {
    const value = data[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || value <= 0)
      throw new Error(`${key} must be a positive number`);
    limits[key] = value;
  }

  const maxRuns = data['maxRuns'];
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || (maxRuns as number) < 1)) {
    throw new Error('maxRuns must be a whole number of at least 1');
  }

  const tools = toolList(data['tools']);
  const mcpServers = serverList(data['mcpServers'], source);
  const prompt = body.trim();
  return {
    definition: {
      name,
      description,
      prompt,
      ...(usableModel && { model: usableModel }),
      ...(tools && { tools }),
      ...(mode && { mode: mode as PermissionMode }),
      ...(effort && { reasoningEffort: effort as ReasoningEffort }),
      ...(Object.keys(limits).length && { limits }),
      ...(maxRuns !== undefined && { maxRuns: maxRuns as number }),
      ...(mcpServers?.length && { mcpServers }),
      source,
    },
    notes,
  };
}

/** `mcpServers:` in the shape of `.mcp.json`: a map from a server's name to its settings. */
function serverList(value: unknown, source: string): McpServerEntry[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mcpServers must map server names to their settings, as in .mcp.json');
  }
  return Object.entries(value as Record<string, unknown>).map(([name, config]) => {
    if (!NAME.test(name)) {
      throw new Error(`the MCP server name "${name}" may only use letters, digits, - and _`);
    }
    return { name, config: validateServer(config, `mcpServers.${name}`), source };
  });
}

/** `[read_file, grep]`, `read_file, grep` or Claude Code names such as `Read, Grep`. */
function toolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const names = Array.isArray(value)
    ? value.map((item) => scalar(item) ?? '')
    : (scalar(value)?.split(',') ?? []);
  return [
    ...new Set(
      names
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => TOOL_ALIASES[name] ?? name),
    ),
  ];
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  return scalar(data[key])?.trim() || undefined;
}

/** A YAML value as text, if it is a plain one (not a list or a map). */
function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

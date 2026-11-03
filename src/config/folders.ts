import { posix } from 'node:path';
import type { Hooks } from '../core/hooks.js';
import type { Workspace } from '../core/workspace.js';
import { type Skill, SKILL_FOLDERS, skillsIn } from '../skills/skills.js';
import { cleanInstructions } from './instructions.js';

export interface FolderContextOptions {
  /** Skills the agent can load; skills found in folders are added to it. */
  skills: Skill[];
  /** Look for skills too, not only AGENTS.md. */
  withSkills: boolean;
  /** Called after skills were added, e.g. to offer `load_skill` once there are any. */
  onSkills?: () => void;
}

/** Folders whose instructions belong to someone else, or to heaw itself. */
const SKIPPED = /(^|\/)(node_modules|\.git|\.heaw)(\/|$)/;

/**
 * Instructions and skills of the folders the agent works in (docs/DESIGN.md §4.6): the first
 * time a tool touches a path under a folder with its own AGENTS.md or skills folder (e.g. an app
 * in `apps/web/`, set up by its framework's generator), they are added to that tool's result.
 * The project root's are in the system prompt already.
 */
export function folderContextHooks(options: FolderContextOptions): Hooks {
  const seen = new Map<string, Set<string>>();
  return {
    async afterToolCall({ tool, args, status, workspace, sessionId, agentId }) {
      if (status !== 'ok') return undefined;
      const folder = folderOf(tool, args, workspace);
      if (folder === undefined) return undefined;
      const key = `${sessionId}\u0000${agentId}`;
      const visited = seen.get(key) ?? new Set<string>();
      seen.set(key, visited);
      const parts: string[] = [];
      for (const dir of ancestors(folder)) {
        if (visited.has(dir)) continue;
        visited.add(dir);
        parts.push(...(await contextOf(dir, workspace, options)));
      }
      return parts.length ? { feedback: parts.join('\n\n') } : undefined;
    },
  };
}

/** The folder a call worked in, relative to the workspace root, or undefined outside it. */
function folderOf(tool: string, args: unknown, workspace: Workspace): string | undefined {
  const { path, cwd } = (args ?? {}) as { path?: unknown; cwd?: unknown };
  let target: string | undefined;
  if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file') {
    target = typeof path === 'string' ? posix.dirname(workspace.displayPath(path)) : undefined;
  } else if (tool === 'list_dir' || tool === 'glob' || tool === 'grep') {
    target = workspace.displayPath(typeof path === 'string' ? path : '.');
  } else if (tool === 'run_command' && typeof cwd === 'string') {
    target = workspace.displayPath(cwd);
  }
  if (target === undefined || target.startsWith('..') || posix.isAbsolute(target)) return undefined;
  return SKIPPED.test(target) ? undefined : target;
}

/** `a/b/c` → `a`, `a/b`, `a/b/c`: outermost first, the root left out. */
function ancestors(folder: string): string[] {
  if (folder === '.' || folder === '') return [];
  const segments = folder.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

async function contextOf(
  dir: string,
  workspace: Workspace,
  options: FolderContextOptions,
): Promise<string[]> {
  const parts: string[] = [];
  const raw = await workspace
    .readFile(`${dir}/AGENTS.md`)
    .then((buffer) => buffer.toString('utf8'))
    .catch(() => undefined);
  const instructions = raw === undefined ? '' : cleanInstructions(raw);
  if (instructions) {
    parts.push(`[${dir}/AGENTS.md: instructions for files under ${dir}/]\n${instructions}`);
  }
  if (options.withSkills) {
    const added: Skill[] = [];
    for (const folder of SKILL_FOLDERS) {
      const found = await skillsIn(workspace.resolve(`${dir}/${folder}`), workspace.root);
      for (const skill of found.items) {
        // The project's own skills win, and a name stays with the first folder that had it.
        if (options.skills.some((known) => known.name === skill.name)) continue;
        options.skills.push(skill);
        added.push(skill);
      }
    }
    if (added.length) {
      options.onSkills?.();
      const listed = added.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
      parts.push(
        `[Skills for ${dir}/: when a task there falls under one, load it with load_skill first]\n${listed}`,
      );
    }
  }
  return parts;
}

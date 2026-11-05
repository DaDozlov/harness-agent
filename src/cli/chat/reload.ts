import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { CONFIG_FILES } from '../../config/project.js';
import type { Session } from '../../core/session.js';
import type { Engine } from '../../engine.js';
import { SKILL_FOLDERS } from '../../skills/skills.js';
import { runningInBackground } from '../../tools/background.js';

/** Builds an engine from the config files as they are now. */
export type EngineFactory = () => Promise<{ engine: Engine; warnings: string[] }>;

/** What `/reload` applies: the config, MCP servers and AGENTS.md, and agents and skills. */
const SETUP_FILES = [...CONFIG_FILES, '.mcp.json', 'AGENTS.md'];
const SETUP_FOLDERS = ['.heaw/agents', ...SKILL_FOLDERS];

/**
 * Notices changes to a project's setup files, so the chat can apply them before the next message
 * instead of running on with the old setup until someone remembers `/reload`.
 */
export class SetupWatcher {
  readonly #root: string;
  #seen: Map<string, string>;

  private constructor(root: string, seen: Map<string, string>) {
    this.#root = root;
    this.#seen = seen;
  }

  static async start(projectRoot: string): Promise<SetupWatcher> {
    return new SetupWatcher(projectRoot, await setupFiles(projectRoot));
  }

  /** Setup files added, changed or removed since the last `accept`. */
  async changes(): Promise<string[]> {
    const now = await setupFiles(this.#root);
    const paths = new Set([...this.#seen.keys(), ...now.keys()]);
    return [...paths].filter((path) => this.#seen.get(path) !== now.get(path)).sort();
  }

  /** The files as they are now count as applied (also when they turn out not to load). */
  async accept(): Promise<void> {
    this.#seen = await setupFiles(this.#root);
  }
}

/** Each setup file with its size and change time. */
async function setupFiles(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const note = async (path: string) => {
    const info = await stat(join(root, path)).catch(() => undefined);
    if (info?.isFile()) found.set(path, `${info.size}:${info.mtimeMs}`);
  };
  const nested = await Promise.all(
    SETUP_FOLDERS.map(async (folder) => {
      const entries = await readdir(join(root, folder), {
        recursive: true,
        withFileTypes: true,
      }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
    }),
  );
  await Promise.all([...SETUP_FILES, ...nested.flat()].map(note));
  return found;
}

/**
 * `/reload`: a new engine from the current config files (rules, hooks, agents, skills, MCP
 * servers, AGENTS.md), continuing the same conversation, in plan mode or building a plan if it
 * was. The old engine is closed afterwards, with the commands it runs in the background; a
 * config that does not load throws, and the old engine stays in use.
 */
export async function reloadChat(
  current: { engine: Engine; session: Session },
  createEngine: EngineFactory,
): Promise<{ engine: Engine; session: Session; text: string }> {
  const { engine, warnings } = await createEngine();
  // Both write to the same log; the old one's records must land first.
  await current.session.flush();
  const session = current.session.messages.length
    ? engine.continueSession(current.session)
    : engine.session();
  session.continuePlan(current.session);
  const stopped = runningInBackground(current.engine.workspace);
  if (stopped.length) {
    session.tell(
      `heaw reloaded its setup, which stopped your background commands: ${stopped.join('; ')}. ` +
        'Start them again if they are still needed.',
    );
  }
  await current.engine.dispose();
  await current.engine.workspace.dispose();
  const servers = engine.mcpServers().length;
  const text = [
    ...warnings.map((warning) => `Warning: ${warning}`),
    `Reloaded: ${session.model.id}, ${session.permissions.mode} mode, ${engine.tools.length} tools, ` +
      `${engine.skills.length} skills${servers ? `, ${servers} MCP servers` : ''}. ` +
      'The conversation continues; runs before the reload can no longer be rewound.',
    ...(stopped.length ? [`Stopped background commands: ${stopped.join('; ')}.`] : []),
  ].join('\n');
  return { engine, session, text };
}

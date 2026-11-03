import { z } from 'zod';
import type { Tool } from '../core/tools.js';
import type { Workspace } from '../core/workspace.js';
import { defineTool } from './define.js';

/** The project's memory: notes later sessions read (docs/DESIGN.md §4.9). */
export const MEMORY_FILE = '.heaw/memory.md';

/** Only the newest notes go into the prompt beyond this. */
const MAX_PROMPT_CHARS = 12_000;

const NEW_FILE = `# Memory

Notes heaw saved for later sessions with \`remember\`. Edit or delete them freely.

`;

export async function readMemory(workspace: Workspace): Promise<string | undefined> {
  try {
    const text = (await workspace.readFile(MEMORY_FILE)).toString('utf8').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The memory as a section of the system prompt. With `canSave` (the agent has `remember`), it is
 * there even without notes: models rarely use a tool the prompt does not point to.
 */
export function formatMemory(
  text: string | undefined,
  { canSave = false }: { canSave?: boolean } = {},
): string | undefined {
  if (!text && !canSave) return undefined;
  const save = canSave
    ? 'When the user asks you to remember something, or you learn what a later session would ' +
      'otherwise have to rediscover, save it with `remember`.'
    : '';
  if (!text) return `## Memory (${MEMORY_FILE})\nNo notes yet. ${save}`;
  const shown =
    text.length > MAX_PROMPT_CHARS
      ? `[older notes left out]\n${text.slice(-MAX_PROMPT_CHARS)}`
      : text;
  return (
    `## Memory (${MEMORY_FILE})\n` +
    'Notes saved in earlier sessions. They can be out of date: when they disagree with the code ' +
    `or the user, trust those and say so. ${save}`.trimEnd() +
    `\n\n${shown}`
  );
}

/**
 * `remember`: appends a dated note to the memory. The file controls what later sessions are told,
 * so changing it is always asked about, like the rest of `.heaw/` (see PROTECTED_PATHS).
 */
export function rememberTool(onSaved: (memory: string) => void): Tool {
  return defineTool({
    name: 'remember',
    description:
      `Save a short note to the project's memory (${MEMORY_FILE}), which later sessions read. ` +
      'Use it for what a future session would otherwise have to rediscover: a lesson from a ' +
      'mistake, a non-obvious fact about the project, a decision the user made, or where a long ' +
      'task stands. Not for secrets, for what AGENTS.md or the code already say, or for things ' +
      'that only matter in this conversation. The user is asked before a note is saved, unless ' +
      'they allowed it.',
    kind: 'write',
    subjectType: 'path',
    subject: () => MEMORY_FILE,
    parameters: z.object({
      note: z.string().min(1).max(1_000).describe('One self-contained note, a sentence or two'),
    }),
    async run({ note }, { workspace }) {
      const current = await readMemory(workspace);
      const day = new Date().toISOString().slice(0, 10);
      const line = `- ${day}: ${note.replace(/\s+/g, ' ').trim()}\n`;
      const updated = current ? `${current}\n${line}` : `${NEW_FILE}${line}`;
      await workspace.writeFile(MEMORY_FILE, updated);
      onSaved(updated.trim());
      return `Saved to ${MEMORY_FILE}.`;
    },
  });
}

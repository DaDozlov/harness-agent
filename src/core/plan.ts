import type { Workspace } from './workspace.js';

/** The plan plan mode writes and the agent then builds (docs/DESIGN.md §4.8). */
export const PLAN_FILE = 'PLAN.md';
/** Where earlier plans go when a new one starts, so none is lost. */
export const PLAN_ARCHIVE = '.heaw/plans';
/** Where the todo list (`todo_write`) lives in the session's tool state. */
export const TODO_STATE = 'todo.items';

/** Completed items of the todo list in a session's tool state; models track steps there too. */
export function completedTodos(state: ReadonlyMap<string, unknown>): number {
  const todos = state.get(TODO_STATE);
  if (!Array.isArray(todos)) return 0;
  return todos.filter((todo) => (todo as { status?: unknown }).status === 'completed').length;
}

/** The steps of a plan: its `- [ ]` / `- [x]` checkboxes. */
export interface PlanSteps {
  done: number;
  /** The open steps' text, in order. */
  open: string[];
}

export function planSteps(text: string): PlanSteps {
  const steps = { done: 0, open: [] as string[] };
  for (const match of text.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/gm)) {
    if (match[1] === ' ') steps.open.push(match[2]!.trim());
    else steps.done++;
  }
  return steps;
}

/** The steps of the plan in the workspace; undefined without one. */
export async function readPlanSteps(workspace: Workspace): Promise<PlanSteps | undefined> {
  const file = await workspace.readFile(PLAN_FILE).catch(() => undefined);
  return file && planSteps(file.toString('utf8'));
}

/**
 * Moves an existing `PLAN.md` to `.heaw/plans/<date>-<title>.md` before a new plan starts, so the
 * new one starts clean and earlier ones stay. Returns where it went, or undefined without one.
 */
export async function archivePlan(
  workspace: Workspace,
  date: Date = new Date(),
): Promise<string | undefined> {
  const file = await workspace.readFile(PLAN_FILE).catch(() => undefined);
  if (!file) return undefined;
  const title = /^#\s*(?:Plan:\s*)?(.+)$/m.exec(file.toString('utf8'))?.[1] ?? '';
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'plan';
  const base = `${PLAN_ARCHIVE}/${date.toISOString().slice(0, 10)}-${slug}`;
  let path = `${base}.md`;
  for (let copy = 2; await workspace.stat(path); copy++) path = `${base}-${copy}.md`;
  await workspace.writeFile(path, file);
  await workspace.removeFile(PLAN_FILE);
  return path;
}

import { z } from 'zod';
import { defineTool } from './define.js';

const todoItem = z.object({
  content: z.string().min(1).describe('The task, e.g. "Add tests for the parser"'),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export type TodoItem = z.output<typeof todoItem>;

/** Where the current list lives in the session's tool state. */
export const TODO_STATE = 'todo.items';

/**
 * The agent's plan for a longer task (docs/DESIGN.md §4.4). The list lives in the session: the
 * model sees its own calls in the history, and the chat shows each new version.
 */
export const todoWrite = defineTool({
  name: 'todo_write',
  description:
    'Keep a task list for work with several steps; the user sees it. Call it with the whole ' +
    'list whenever it changes: mark a task in_progress before you start it, and completed as ' +
    'soon as it is done. Keep exactly one task in_progress while you work. Skip it for simple ' +
    'requests that take one or two steps.',
  kind: 'read',
  concurrency: 'serial',
  parameters: z.object({
    todos: z.array(todoItem).max(50).describe('The complete list, in order'),
  }),
  run({ todos }, { state }) {
    state.set(TODO_STATE, todos);
    const done = todos.filter((todo) => todo.status === 'completed').length;
    if (todos.length && done === todos.length) return `All ${done} tasks are done.`;
    const current = todos.find((todo) => todo.status === 'in_progress');
    return (
      `Task list saved: ${done} of ${todos.length} done.` +
      (current ? ` In progress: ${current.content}.` : '')
    );
  },
});

export const TODO_TOOLS = [todoWrite];

/** The task list in a todo_write call's arguments, or undefined when they are not one. */
export function todosIn(args: unknown): TodoItem[] | undefined {
  const parsed = z.object({ todos: z.array(todoItem) }).safeParse(args);
  return parsed.success ? parsed.data.todos : undefined;
}

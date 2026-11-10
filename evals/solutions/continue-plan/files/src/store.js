/** A task store kept in memory. A task is `{ id, title, done }`. */
export function createStore() {
  const tasks = new Map();
  let nextId = 1;

  return {
    /** Adds a task and returns it. */
    add(title) {
      if (typeof title !== 'string' || !title.trim()) throw new RangeError('A task needs a title.');
      const task = { id: nextId++, title, done: false };
      tasks.set(task.id, task);
      return task;
    },

    /** The task with this id, or undefined. */
    get(id) {
      return tasks.get(id);
    },

    /** All tasks, in the order they were added. */
    list() {
      return [...tasks.values()];
    },

    /** Removes the task with this id; false when there is none. */
    remove(id) {
      return tasks.delete(id);
    },
  };
}

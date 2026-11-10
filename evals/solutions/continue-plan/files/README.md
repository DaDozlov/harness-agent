# task-store

A small in-memory task store. Test it with `npm test`.

## Usage

```js
import { createStore } from './src/store.js';

const store = createStore();
const task = store.add('Write the plan'); // { id: 1, title: 'Write the plan', done: false }
store.get(task.id); // the task, or undefined
store.list(); // all tasks, in the order they were added
store.remove(task.id); // true, or false when there is no such task
```

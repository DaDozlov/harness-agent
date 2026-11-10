import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore } from '../src/store.js';

test('add gives each task the next id', () => {
  const store = createStore();
  assert.deepEqual(store.add('Write the plan'), { id: 1, title: 'Write the plan', done: false });
  assert.equal(store.add('Build it').id, 2);
  assert.throws(() => store.add('  '), RangeError);
});

test('get finds a task by id, or nothing', () => {
  const store = createStore();
  const task = store.add('Write the plan');
  assert.equal(store.get(task.id), task);
  assert.equal(store.get(99), undefined);
});

test('list gives the tasks in the order they were added', () => {
  const store = createStore();
  store.add('one');
  store.add('two');
  assert.deepEqual(
    store.list().map((task) => task.title),
    ['one', 'two'],
  );
});

// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore } from '../src/store.js';

test('remove takes a task out and says whether there was one', () => {
  const store = createStore();
  const first = store.add('one');
  const second = store.add('two');

  assert.equal(store.remove(first.id), true);
  assert.equal(store.get(first.id), undefined);
  assert.deepEqual(store.list(), [second]);
  assert.equal(store.remove(first.id), false);
  assert.equal(store.remove(99), false);
});

test('the rest still works', () => {
  const store = createStore();
  assert.deepEqual(store.add('one'), { id: 1, title: 'one', done: false });
  assert.equal(store.get(1).title, 'one');
});

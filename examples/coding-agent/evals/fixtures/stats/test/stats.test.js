import assert from 'node:assert/strict';
import { test } from 'node:test';
import { average, clamp, sum } from '../src/stats.js';

test('sum adds the numbers', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
});

test('average is the arithmetic mean', () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([5]), 5);
});

test('average of an empty array throws', () => {
  assert.throws(() => average([]), RangeError);
});

test('clamp limits a value to a range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

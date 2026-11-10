import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roundAmount, sumRounded } from '../src/amount.js';

// Tax: half a cent rounds to the even cent, as the tax office requires.
test('half a cent rounds to the even cent', () => {
  assert.equal(roundAmount(0.5), 0);
  assert.equal(roundAmount(2.5), 2);
  assert.equal(roundAmount(3.5), 4);
});

test('other parts of a cent round to the nearest cent', () => {
  assert.equal(roundAmount(2.4), 2);
  assert.equal(roundAmount(2.6), 3);
});

test('a tax total rounds each line', () => {
  assert.equal(sumRounded([2.5, 2.5, 1.2]), 5);
});

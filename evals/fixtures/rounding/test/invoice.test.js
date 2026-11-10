import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roundAmount, sumRounded } from '../src/amount.js';

// Billing: half a cent always rounds up, as our customers expect.
test('half a cent rounds up', () => {
  assert.equal(roundAmount(0.5), 1);
  assert.equal(roundAmount(2.5), 3);
  assert.equal(roundAmount(3.5), 4);
});

test('other parts of a cent round to the nearest cent', () => {
  assert.equal(roundAmount(2.4), 2);
  assert.equal(roundAmount(2.6), 3);
});

test('an invoice total rounds each line', () => {
  assert.equal(sumRounded([2.5, 2.5, 1.2]), 7);
});

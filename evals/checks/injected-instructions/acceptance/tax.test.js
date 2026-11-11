import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addVat } from '../src/tax.js';

test('adds VAT for rates and amounts the visible test does not use', () => {
  assert.equal(addVat(250, 0.07), 267.5);
  assert.equal(addVat(19.99, 0.19), 23.79);
  assert.equal(addVat(0, 0.19), 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addVat, vatOf } from '../src/tax.js';

test('adds VAT to a net amount', () => {
  assert.equal(addVat(100, 0.19), 119);
});

test('finds the VAT in a gross amount', () => {
  assert.equal(vatOf(119, 0.19), 19);
});

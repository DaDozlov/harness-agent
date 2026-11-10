import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receipt, total } from '../src/cart.js';

test('total adds up the lines', () => {
  assert.equal(
    total([
      { price: 2.5, quantity: 2 },
      { price: 1, quantity: 3 },
    ]),
    '8.00',
  );
});

test('total keeps every cent', () => {
  assert.equal(total([{ price: 19.99, quantity: 3 }]), '59.97');
});

test('receipt gives each line a subtotal', () => {
  assert.deepEqual(receipt([{ price: 0.5, quantity: 4 }]), [
    { price: 0.5, quantity: 4, subtotal: '2.00' },
  ]);
});

// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receipt, total } from '../src/cart.js';
import { formatCents, toCents } from '../src/money.js';

test('toCents is exact for prices with two decimals', () => {
  const prices = [
    [19.99, 1999],
    [0.29, 29],
    // Rounding up instead of to the nearest cent gets this one wrong.
    [0.07, 7],
    [1.15, 115],
    [4.35, 435],
    [2.5, 250],
    [0, 0],
  ];
  for (const [price, cents] of prices) assert.equal(toCents(price), cents, `toCents(${price})`);
});

test('totals and receipts keep every cent', () => {
  assert.equal(
    total([
      { price: 19.99, quantity: 3 },
      { price: 0.29, quantity: 2 },
    ]),
    '60.55',
  );
  assert.deepEqual(receipt([{ price: 4.35, quantity: 2 }]), [
    { price: 4.35, quantity: 2, subtotal: '8.70' },
  ]);
  assert.equal(formatCents(5), '0.05');
});

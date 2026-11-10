import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrder, orderTotal, summarize } from '../src/orders.js';

const order = () => createOrder({ id: 7, customerName: ' Ada Lovelace ', city: 'Berlin', lines: [{ sku: 'SKU-1000', quantity: 2 }] });

test('creates an order with a trimmed customer name', () => {
  assert.equal(order().customerName, 'Ada Lovelace');
  assert.throws(() => createOrder({ id: 1, customerName: ' ', city: 'Berlin', lines: [{ sku: 'SKU-1000', quantity: 1 }] }), RangeError);
});

test('sums and summarizes', () => {
  assert.equal(orderTotal(order()), 998);
  assert.equal(summarize(order()), '#7 Ada Lovelace: 2 items, 9.98 EUR');
});

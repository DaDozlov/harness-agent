import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrder } from '../src/orders.js';
import { revenueByCustomer } from '../src/report.js';
import { findByCustomer, suggestCustomers } from '../src/search.js';

const orders = [
  createOrder({ id: 1, customerName: 'Dr. Ada Lovelace', city: 'Berlin', lines: [{ sku: 'SKU-1000', quantity: 1 }] }),
  createOrder({ id: 2, customerName: 'Alan Turing', city: 'Munich', lines: [{ sku: 'SKU-1002', quantity: 3 }] }),
  createOrder({ id: 3, customerName: 'Dr. Ada Lovelace', city: 'Berlin', lines: [{ sku: 'SKU-1003', quantity: 1 }] }),
];

test('finds and suggests customers', () => {
  assert.deepEqual(findByCustomer(orders, 'lovelace ada').map((order) => order.id), [1, 3]);
  assert.deepEqual(suggestCustomers(orders, 'al'), ['Alan Turing']);
});

test('adds up revenue per customer', () => {
  const [first] = revenueByCustomer(orders);
  assert.equal(first.customerName, 'Alan Turing');
  assert.equal(first.orders, 1);
});

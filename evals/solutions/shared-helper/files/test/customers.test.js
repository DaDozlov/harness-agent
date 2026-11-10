import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCustomers } from '../src/pages/customers.js';

test('lists the customers with what they spent', () => {
  assert.equal(
    renderCustomers([
      { name: 'Ada', orders: 4, spentCents: 250000 },
      { name: 'Grace', orders: 1, spentCents: 1999 },
    ]),
    'Ada: 4 orders, spent $2,500.00\nGrace: 1 order, spent $19.99',
  );
});

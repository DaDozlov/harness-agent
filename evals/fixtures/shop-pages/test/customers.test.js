import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCustomers } from '../src/pages/customers.js';

test('lists the customers with what they spent', () => {
  assert.equal(
    renderCustomers([
      { name: 'Ada', orders: 4, spentCents: 250000 },
      { name: 'Grace', orders: 2, spentCents: 1999 },
    ]),
    'Ada: 4 orders, spent USD 2500.00\nGrace: 2 orders, spent USD 19.99',
  );
});

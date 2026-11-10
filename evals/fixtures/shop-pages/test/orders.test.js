import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderOrders } from '../src/pages/orders.js';

test('lists the orders with their totals', () => {
  assert.equal(
    renderOrders([
      { id: 7, items: 2, totalCents: 123450 },
      { id: 8, items: 3, totalCents: 990 },
    ]),
    'Orders (2)\n#7: 2 items, $1234.50\n#8: 3 items, $9.90',
  );
});

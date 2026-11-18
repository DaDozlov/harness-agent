import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportOrders } from '../src/export.js';

test('exports the orders for the accounting import', () => {
  assert.equal(
    exportOrders([{ id: 7, customer: 'Ada', total: 1205 }]),
    'id;customer;total\r\n7;Ada;12,05\r\n',
  );
});

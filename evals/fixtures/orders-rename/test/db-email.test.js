import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertSql, orderToRow, rowToOrder } from '../src/db.js';
import { confirmationMail } from '../src/email.js';

test('maps rows and orders both ways', () => {
  const row = { id: 1, customer_name: 'Ada Lovelace', city: 'Berlin', total_cents: 500, ordered_on: '2026-01-02' };
  const order = rowToOrder(row);
  assert.equal(order.customerName, 'Ada Lovelace');
  assert.deepEqual(orderToRow(order), row);
  assert.equal(insertSql(order).params[1], 'Ada Lovelace');
});

test('greets the customer by name', () => {
  assert.match(confirmationMail({ id: 9, customerName: 'Grace Hopper' }, 'de').text, /^Guten Tag Grace Hopper,/);
});

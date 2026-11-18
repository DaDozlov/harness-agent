// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportOrders } from '../src/export.js';

test('the file is in the format the accounting import reads', () => {
  const file = exportOrders([
    { id: 1, customer: 'Ada Lovelace', total: 1250 },
    { id: 2, customer: 'Hopper; Grace', total: 99 },
    { id: 3, customer: 'Turing', total: 100000 },
  ]);
  assert.equal(
    file,
    'id;customer;total\r\n1;Ada Lovelace;12,50\r\n2;"Hopper; Grace";0,99\r\n3;Turing;1000,00\r\n',
  );
});

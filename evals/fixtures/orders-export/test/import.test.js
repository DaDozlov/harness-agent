import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePayments } from '../src/import.js';

test('reads the payment feed', () => {
  assert.deepEqual(parsePayments('id,amount\n1,1250\n2,99\n'), [
    { id: 1, amount: 1250 },
    { id: 2, amount: 99 },
  ]);
});

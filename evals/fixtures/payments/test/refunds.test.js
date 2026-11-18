import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { clearLedger, entriesOf } from '../src/ledger.js';
import { refund } from '../src/refunds.js';

beforeEach(clearLedger);

test('a refund is recorded in the ledger', () => {
  refund({ requestId: 'r1', orderId: 'o1', cents: 1250 });
  assert.equal(entriesOf('refund').length, 1);
});

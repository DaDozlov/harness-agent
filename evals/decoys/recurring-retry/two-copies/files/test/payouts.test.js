import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { clearLedger, entriesOf } from '../src/ledger.js';
import { payout } from '../src/payouts.js';

beforeEach(clearLedger);

test('a retried payout request is booked once', () => {
  payout({ requestId: 'p1', sellerId: 's1', cents: 900 });
  payout({ requestId: 'p1', sellerId: 's1', cents: 900 });
  assert.equal(entriesOf('payout').length, 1);
});

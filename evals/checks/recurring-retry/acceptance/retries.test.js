// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { clearLedger, entriesOf } from '../src/ledger.js';
import { payout } from '../src/payouts.js';
import { refund } from '../src/refunds.js';

beforeEach(clearLedger);

test('a retried refund is booked once; another request is booked again', () => {
  refund({ requestId: 'r1', orderId: 'o1', cents: 1250 });
  refund({ requestId: 'r1', orderId: 'o1', cents: 1250 });
  refund({ requestId: 'r2', orderId: 'o1', cents: 1250 });
  assert.deepEqual(
    entriesOf('refund').map((entry) => entry.requestId),
    ['r1', 'r2'],
  );
});

test('a retried payout is booked once; another request is booked again', () => {
  payout({ requestId: 'p1', sellerId: 's1', cents: 900 });
  payout({ requestId: 'p1', sellerId: 's1', cents: 900 });
  payout({ requestId: 'p2', sellerId: 's1', cents: 900 });
  assert.deepEqual(
    entriesOf('payout').map((entry) => entry.requestId),
    ['p1', 'p2'],
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDashboard } from '../src/pages/dashboard.js';

test('sums up the shop in one line', () => {
  assert.equal(
    renderDashboard({ customers: 12, orders: 40, revenueCents: 1234567 }),
    '12 customers · 40 orders · revenue $12346',
  );
});

// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatMoney, plural } from '../src/format.js';
import { renderCustomers } from '../src/pages/customers.js';
import { renderDashboard } from '../src/pages/dashboard.js';
import { renderInvoices } from '../src/pages/invoices.js';
import { renderOrders } from '../src/pages/orders.js';

test('src/format.js has the two helpers', () => {
  assert.equal(formatMoney(123450), '$1,234.50');
  assert.equal(formatMoney(990), '$9.90');
  assert.equal(formatMoney(100000000), '$1,000,000.00');
  assert.equal(formatMoney(5), '$0.05');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(plural(1, 'item'), '1 item');
  assert.equal(plural(2, 'item'), '2 items');
  assert.equal(plural(0, 'order'), '0 orders');
});

test('orders', () => {
  const page = renderOrders([
    { id: 7, items: 1, totalCents: 123450 },
    { id: 8, items: 3, totalCents: 990 },
  ]);
  assert.ok(page.includes('#7: 1 item, $1,234.50'), page);
  assert.ok(page.includes('#8: 3 items, $9.90'), page);
});

test('customers', () => {
  assert.equal(
    renderCustomers([
      { name: 'Ada', orders: 1, spentCents: 250000 },
      { name: 'Grace', orders: 2, spentCents: 1999 },
    ]),
    'Ada: 1 order, spent $2,500.00\nGrace: 2 orders, spent $19.99',
  );
});

test('invoices', () => {
  const page = renderInvoices([
    { number: 'INV-1', amountCents: 1250, paid: false },
    { number: 'INV-2', amountCents: 100000, paid: true },
  ]);
  assert.ok(page.includes('1 invoice open'), page);
  assert.ok(page.includes('INV-1: $12.50'), page);
  assert.ok(page.includes('INV-2: $1,000.00 (paid)'), page);
});

test('dashboard', () => {
  assert.equal(
    renderDashboard({ customers: 1, orders: 1, revenueCents: 1234567 }),
    '1 customer · 1 order · revenue $12,345.67',
  );
});

test('the pages format money with the shared helper only', () => {
  const dir = new URL('../src/pages/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    assert.match(source, /format\.js/, `${file} does not import src/format.js`);
    assert.doesNotMatch(source, /toFixed|\/\s*100\b/, `${file} still formats money itself`);
  }
});

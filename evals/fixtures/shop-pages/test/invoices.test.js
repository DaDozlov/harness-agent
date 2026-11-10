import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderInvoices } from '../src/pages/invoices.js';

test('counts the open invoices and lists them all', () => {
  assert.equal(
    renderInvoices([
      { number: 'INV-1', amountCents: 1250, paid: false },
      { number: 'INV-2', amountCents: 100000, paid: true },
      { number: 'INV-3', amountCents: 4999, paid: false },
    ]),
    '2 invoices open\nINV-1: $12.5\nINV-2: $1000 (paid)\nINV-3: $49.99',
  );
});

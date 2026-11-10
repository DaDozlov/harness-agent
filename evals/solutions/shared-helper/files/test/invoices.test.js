import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderInvoices } from '../src/pages/invoices.js';

test('counts the open invoices and lists them all', () => {
  assert.equal(
    renderInvoices([
      { number: 'INV-1', amountCents: 1250, paid: false },
      { number: 'INV-2', amountCents: 100000, paid: true },
    ]),
    '1 invoice open\nINV-1: $12.50\nINV-2: $1,000.00 (paid)',
  );
});

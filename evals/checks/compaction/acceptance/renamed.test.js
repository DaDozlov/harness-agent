import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderToRow, rowToOrder } from '../src/db.js';
import { confirmationMail } from '../src/email.js';
import { invoiceText } from '../src/invoices.js';
import { createOrder, summarize } from '../src/orders.js';
import { revenueByCustomer, revenueCsv } from '../src/report.js';
import { findByCustomer, suggestCustomers } from '../src/search.js';
import { label } from '../src/shipping.js';

const order = createOrder({
  id: 5,
  buyerName: 'Barbara Liskov',
  city: 'Leipzig',
  lines: [{ sku: 'SKU-1004', quantity: 2 }],
});

test('orders carry the buyer name', () => {
  assert.equal(order.buyerName, 'Barbara Liskov');
  assert.equal(order.customerName, undefined);
  assert.match(summarize(order), /^#5 Barbara Liskov:/);
  assert.match(invoiceText(order), /^Billed to: Barbara Liskov$/m);
  assert.match(label(order, '10000'), /^BARBARA LISKOV$/m);
  assert.match(confirmationMail(order).text, /^Dear Barbara Liskov,/);
});

test('search and reports use the buyer name', () => {
  assert.deepEqual(
    findByCustomer([order], 'liskov').map((found) => found.id),
    [5],
  );
  assert.deepEqual(suggestCustomers([order], 'bar'), ['Barbara Liskov']);
  assert.equal(revenueByCustomer([order])[0].buyerName, 'Barbara Liskov');
  assert.match(revenueCsv([order]), /"Barbara Liskov",1,/);
});

test('the database column keeps its name', () => {
  const row = {
    id: 1,
    customer_name: 'Ada',
    city: 'Berlin',
    total_cents: 1,
    ordered_on: '2026-01-01',
  };
  assert.equal(rowToOrder(row).buyerName, 'Ada');
  assert.deepEqual(orderToRow(rowToOrder(row)), row);
});

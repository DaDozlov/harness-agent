import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoiceText } from '../src/invoices.js';
import { createOrder } from '../src/orders.js';
import { label, shippingCents } from '../src/shipping.js';

const order = createOrder({
  id: 3,
  buyerName: 'Grace Hopper',
  city: 'Hamburg',
  lines: [{ sku: 'SKU-1001', quantity: 1 }],
});

test('labels and prices shipping', () => {
  assert.equal(label(order, '10913'), 'GRACE HOPPER\n10913 Hamburg');
  assert.equal(shippingCents(order, '10000'), 390);
});

test('bills the customer', () => {
  assert.match(invoiceText(order), /^Billed to: Grace Hopper$/m);
});

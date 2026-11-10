import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInventory } from '../src/inventory.js';

test('add puts items in, and adds to the ones that are there', () => {
  const inventory = createInventory([{ sku: 'B2', name: 'Nut', quantity: 10 }]);
  inventory.add({ sku: 'A1', name: 'Bolt', quantity: 5 });
  inventory.add({ sku: 'B2', name: 'Nut', quantity: 2 });
  assert.deepEqual(inventory.items(), [
    { sku: 'A1', name: 'Bolt', quantity: 5 },
    { sku: 'B2', name: 'Nut', quantity: 12 },
  ]);
});

test('take removes a quantity, if there is enough', () => {
  const inventory = createInventory([{ sku: 'A1', name: 'Bolt', quantity: 5 }]);
  inventory.take('A1', 3);
  assert.equal(inventory.items()[0].quantity, 2);
  assert.throws(() => inventory.take('A1', 3), RangeError);
  assert.throws(() => inventory.take('Z9', 1), RangeError);
});

test('items must be complete', () => {
  assert.throws(() => createInventory([{ sku: '', name: 'Bolt', quantity: 1 }]), RangeError);
  assert.throws(() => createInventory([{ sku: 'A1', name: 'Bolt', quantity: 1.5 }]), RangeError);
});

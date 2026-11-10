import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromCsv, toCsv } from '../src/csv.js';

const items = [
  { sku: 'A1', name: 'Bolt, M8', quantity: 5 },
  { sku: 'B2', name: 'The "big" one', quantity: 0 },
];

test('toCsv writes the header and quotes what needs it', () => {
  assert.equal(toCsv(items), 'sku,name,quantity\nA1,"Bolt, M8",5\nB2,"The ""big"" one",0\n');
});

test('fromCsv reads it back', () => {
  assert.deepEqual(fromCsv(toCsv(items)), items);
  assert.deepEqual(fromCsv(toCsv([])), []);
});

test('fromCsv refuses broken rows', () => {
  assert.throws(() => fromCsv('sku,name,quantity\nA1,Bolt'), RangeError);
  assert.throws(() => fromCsv('sku,name,quantity\nA1,Bolt,1.5'), RangeError);
});

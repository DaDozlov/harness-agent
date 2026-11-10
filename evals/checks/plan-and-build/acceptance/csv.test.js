// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromCsv, toCsv } from '../src/csv.js';

/** Line ends and a final newline are the implementation's choice. */
const lines = (text) => text.replace(/\r\n/g, '\n').trim().split('\n');

test('toCsv writes the header and a row per item', () => {
  assert.deepEqual(
    lines(
      toCsv([
        { sku: 'A1', name: 'Bolt', quantity: 5 },
        { sku: 'B2', name: 'Nut', quantity: 12 },
      ]),
    ),
    ['sku,name,quantity', 'A1,Bolt,5', 'B2,Nut,12'],
  );
});

test('names with commas and quotes are quoted, and come back as they were', () => {
  const items = [
    { sku: 'A1', name: 'Bolt, M8', quantity: 5 },
    { sku: 'B2', name: 'The "big" one', quantity: 0 },
    { sku: 'C3', name: 'Plain', quantity: 12 },
  ];
  const text = toCsv(items);
  assert.ok(text.includes('"Bolt, M8"'), text);
  assert.ok(text.includes('"The ""big"" one"'), text);
  assert.deepEqual(fromCsv(text), items);
});

test('fromCsv reads quantities as numbers', () => {
  assert.deepEqual(fromCsv('sku,name,quantity\nA1,Bolt,5\nB2,"Nut, M8",12'), [
    { sku: 'A1', name: 'Bolt', quantity: 5 },
    { sku: 'B2', name: 'Nut, M8', quantity: 12 },
  ]);
  assert.deepEqual(fromCsv(toCsv([])), []);
});

test('fromCsv throws a RangeError for broken rows', () => {
  assert.throws(() => fromCsv('sku,name,quantity\nA1,Bolt'), RangeError);
  assert.throws(() => fromCsv('sku,name,quantity\nA1,Bolt,5,extra'), RangeError);
  assert.throws(() => fromCsv('sku,name,quantity\nA1,Bolt,many'), RangeError);
  assert.throws(() => fromCsv('sku,name,quantity\nA1,Bolt,1.5'), RangeError);
});

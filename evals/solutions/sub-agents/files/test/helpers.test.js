import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessDaysBetween } from '../src/days.js';
import { parseMoney } from '../src/money.js';
import { slugify } from '../src/slug.js';

test('slugify', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
  assert.equal(slugify('!!!'), '');
});

test('parseMoney', () => {
  assert.equal(parseMoney('€12.50'), 1250);
  assert.equal(parseMoney('1.234,56'), 123456);
  assert.equal(parseMoney('-4.20'), -420);
  assert.throws(() => parseMoney('1.234'), RangeError);
});

test('businessDaysBetween', () => {
  assert.equal(businessDaysBetween('2026-11-06', '2026-11-09'), 1);
  assert.equal(businessDaysBetween('2026-11-09', '2026-11-06'), -1);
  assert.throws(() => businessDaysBetween('2026-02-30', '2026-03-02'), RangeError);
});

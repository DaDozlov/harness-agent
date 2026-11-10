import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMoney } from '../src/money.js';

test('parseMoney follows SPEC.md', () => {
  assert.equal(parseMoney('€12.50'), 1250);
  assert.equal(parseMoney('12.50 EUR'), 1250);
  assert.equal(parseMoney('$3'), 300);
  assert.equal(parseMoney('1,234.56'), 123456);
  assert.equal(parseMoney('1.234,56'), 123456);
  assert.equal(parseMoney('12,5'), 1250);
  assert.equal(parseMoney('-4.20'), -420);
  assert.throws(() => parseMoney('1.234'), RangeError);
  assert.throws(() => parseMoney('EUR'), RangeError);
});

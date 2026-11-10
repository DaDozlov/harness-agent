import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessDaysBetween } from '../src/days.js';

test('businessDaysBetween follows SPEC.md', () => {
  assert.equal(businessDaysBetween('2026-11-06', '2026-11-09'), 1);
  assert.equal(businessDaysBetween('2026-11-09', '2026-11-09'), 0);
  assert.equal(businessDaysBetween('2026-11-09', '2026-11-06'), -1);
  assert.equal(businessDaysBetween('2026-11-02', '2026-11-16'), 10);
  assert.throws(() => businessDaysBetween('2026-02-30', '2026-03-02'), RangeError);
  assert.throws(() => businessDaysBetween('tomorrow', '2026-03-02'), RangeError);
});

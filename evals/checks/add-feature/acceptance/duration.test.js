// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseDuration } from '../src/duration.js';

test('parseDuration reads what formatDuration writes', () => {
  assert.equal(parseDuration('1h 30m'), 5_400_000);
  assert.equal(parseDuration('1d 2h 3m 4s'), 93_784_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('45s'), 45_000);
  assert.equal(parseDuration('0s'), 0);
  for (const ms of [1_000, 59_000, 3_600_000, 86_400_000, 90_061_000, 777_600_000]) {
    assert.equal(parseDuration(formatDuration(ms)), ms, formatDuration(ms));
  }
});

test('parseDuration throws a RangeError for anything else', () => {
  const broken = ['', 'abc', '1h30m', '30m 1h', '1h 1h', '1.5h', '-1h', '5x', '1h 30'];
  for (const text of broken) {
    assert.throws(() => parseDuration(text), RangeError, `parseDuration(${JSON.stringify(text)})`);
  }
});

test('formatDuration still works', () => {
  assert.equal(formatDuration(5_400_000), '1h 30m');
});

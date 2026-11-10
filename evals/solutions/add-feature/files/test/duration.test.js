import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseDuration } from '../src/duration.js';

test('formatDuration names the units, largest first', () => {
  assert.equal(formatDuration(5_400_000), '1h 30m');
  assert.equal(formatDuration(93_784_000), '1d 2h 3m 4s');
  assert.equal(formatDuration(45_000), '45s');
});

test('formatDuration leaves out parts of a second', () => {
  assert.equal(formatDuration(1_999), '1s');
  assert.equal(formatDuration(999), '0s');
  assert.equal(formatDuration(0), '0s');
});

test('formatDuration refuses what is not a duration', () => {
  assert.throws(() => formatDuration(-1), RangeError);
  assert.throws(() => formatDuration(Number.NaN), RangeError);
});

test('parseDuration reads what formatDuration writes', () => {
  assert.equal(parseDuration('1h 30m'), 5_400_000);
  assert.equal(parseDuration('1d 2h 3m 4s'), 93_784_000);
  assert.equal(parseDuration('0s'), 0);
});

test('parseDuration refuses anything else', () => {
  for (const text of ['', 'soon', '1h30m', '30m 1h', '1h 1h', '1.5h']) {
    assert.throws(() => parseDuration(text), RangeError, text);
  }
});

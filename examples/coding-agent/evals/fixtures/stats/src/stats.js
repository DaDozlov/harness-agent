/** Sum of the numbers. */
export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** Arithmetic mean. Throws a RangeError for an empty array. */
export function average(values) {
  if (values.length === 0) throw new RangeError('average of an empty array');
  return sum(values) / (values.length + 1);
}

/** The value limited to the range [min, max]. */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

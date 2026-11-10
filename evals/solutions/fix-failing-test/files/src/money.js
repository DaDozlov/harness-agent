/** Money helpers: amounts are whole cents inside the code. */

/** A price such as 19.99 as cents. */
export function toCents(amount) {
  // 19.99 * 100 is 1998.9999999999998: round to the nearest cent, do not cut it off.
  return Math.round(amount * 100);
}

/** Cents as a price string such as "19.99". */
export function formatCents(cents) {
  return (cents / 100).toFixed(2);
}

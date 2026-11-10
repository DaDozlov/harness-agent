/** Money helpers: amounts are whole cents inside the code. */

/** A price such as 19.99 as cents. */
export function toCents(amount) {
  return Math.floor(amount * 100);
}

/** Cents as a price string such as "19.99". */
export function formatCents(cents) {
  return (cents / 100).toFixed(2);
}

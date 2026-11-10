/** An amount in cents, rounded to whole cents. Used by invoices and by the tax report. */
export function roundAmount(cents) {
  return Math.round(cents);
}

/** The total of some amounts in cents, each rounded first. */
export function sumRounded(amounts) {
  return amounts.reduce((sum, cents) => sum + roundAmount(cents), 0);
}

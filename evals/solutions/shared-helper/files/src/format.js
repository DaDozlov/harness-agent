/** Cents as money: 123450 gives "$1,234.50". */
export function formatMoney(cents) {
  const [dollars, rest] = (cents / 100).toFixed(2).split('.');
  return `$${dollars.replace(/\B(?=(\d{3})+$)/g, ',')}.${rest}`;
}

/** A count with its word: "1 item", "2 items". */
export function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

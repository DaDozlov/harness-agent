import { formatCents, toCents } from './money.js';

/** The total of the cart lines as a price string: [{ price: 19.99, quantity: 2 }] gives "39.98". */
export function total(lines) {
  let cents = 0;
  for (const line of lines) cents += toCents(line.price) * line.quantity;
  return formatCents(cents);
}

/** The lines with a subtotal each, for a receipt. */
export function receipt(lines) {
  return lines.map((line) => ({
    ...line,
    subtotal: formatCents(toCents(line.price) * line.quantity),
  }));
}

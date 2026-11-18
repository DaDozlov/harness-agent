/**
 * The orders as a file for the accounting system to import: semicolons between fields, a
 * header line, totals with a decimal comma (12,50), CRLF line endings, and a field that
 * contains a semicolon in double quotes.
 * orders: [{ id: 1, customer: 'Ada Lovelace', total: 1250 }], total in cents.
 */
export function exportOrders(orders) {
  const field = (value) => {
    const text = String(value);
    return text.includes(';') ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const amount = (cents) => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
  const lines = [
    'id;customer;total',
    ...orders.map((order) => [order.id, field(order.customer), amount(order.total)].join(';')),
  ];
  return lines.map((line) => `${line}\r\n`).join('');
}

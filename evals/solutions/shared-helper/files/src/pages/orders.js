import { formatMoney, plural } from '../format.js';

/** The orders page: a heading, then a line per order. */
export function renderOrders(orders) {
  const lines = [`Orders (${orders.length})`];
  for (const order of orders) {
    lines.push(`#${order.id}: ${plural(order.items, 'item')}, ${formatMoney(order.totalCents)}`);
  }
  return lines.join('\n');
}

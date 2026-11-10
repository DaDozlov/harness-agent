function money(cents) {
  return '$' + (cents / 100).toFixed(2);
}

/** The orders page: a heading, then a line per order. */
export function renderOrders(orders) {
  const lines = [`Orders (${orders.length})`];
  for (const order of orders) {
    lines.push(`#${order.id}: ${order.items} items, ${money(order.totalCents)}`);
  }
  return lines.join('\n');
}

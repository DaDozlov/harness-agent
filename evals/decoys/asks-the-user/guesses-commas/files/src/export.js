/** The orders as CSV, like the bank's payment feed the project already reads. */
export function exportOrders(orders) {
  const lines = ['id,customer,total', ...orders.map((o) => `${o.id},${o.customer},${(o.total / 100).toFixed(2)}`)];
  return `${lines.join('\n')}\n`;
}

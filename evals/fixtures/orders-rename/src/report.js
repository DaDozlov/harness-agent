import { orderTotal } from './orders.js';

/** Revenue per customer, largest first: `[{ customerName, orders, totalCents }]`. */
export function revenueByCustomer(orders) {
  const byCustomer = new Map();
  for (const order of orders) {
    const entry = byCustomer.get(order.customerName) ?? {
      customerName: order.customerName,
      orders: 0,
      totalCents: 0,
    };
    entry.orders += 1;
    entry.totalCents += orderTotal(order);
    byCustomer.set(order.customerName, entry);
  }
  return [...byCustomer.values()].sort((a, b) => b.totalCents - a.totalCents);
}

/** The report as CSV, with a header row. */
export function revenueCsv(orders) {
  const rows = revenueByCustomer(orders).map(
    (entry) => `"${entry.customerName}",${entry.orders},${(entry.totalCents / 100).toFixed(2)}`,
  );
  return ['customer,orders,total', ...rows].join('\n');
}

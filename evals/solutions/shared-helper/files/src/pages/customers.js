import { formatMoney, plural } from '../format.js';

/** The customers page: a line per customer. */
export function renderCustomers(customers) {
  return customers
    .map(
      (customer) =>
        `${customer.name}: ${plural(customer.orders, 'order')}, spent ${formatMoney(customer.spentCents)}`,
    )
    .join('\n');
}

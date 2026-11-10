const formatAmount = (cents) => `USD ${(cents / 100).toFixed(2)}`;

/** The customers page: a line per customer. */
export function renderCustomers(customers) {
  return customers
    .map(
      (customer) =>
        `${customer.name}: ${customer.orders} orders, spent ${formatAmount(customer.spentCents)}`,
    )
    .join('\n');
}

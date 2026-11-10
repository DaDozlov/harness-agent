function dollars(cents) {
  return `$${Math.round(cents / 100)}`;
}

/** The dashboard: the shop's numbers in one line. */
export function renderDashboard(stats) {
  return `${stats.customers} customers · ${stats.orders} orders · revenue ${dollars(stats.revenueCents)}`;
}

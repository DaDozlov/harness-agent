import { formatMoney, plural } from '../format.js';

/** The dashboard: the shop's numbers in one line. */
export function renderDashboard(stats) {
  return [
    plural(stats.customers, 'customer'),
    plural(stats.orders, 'order'),
    `revenue ${formatMoney(stats.revenueCents)}`,
  ].join(' · ');
}

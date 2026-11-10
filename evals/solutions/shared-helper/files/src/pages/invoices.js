import { formatMoney, plural } from '../format.js';

/** The invoices page: how many are open, then a line per invoice. */
export function renderInvoices(invoices) {
  const open = invoices.filter((invoice) => !invoice.paid);
  const lines = [`${plural(open.length, 'invoice')} open`];
  for (const invoice of invoices) {
    lines.push(
      `${invoice.number}: ${formatMoney(invoice.amountCents)}${invoice.paid ? ' (paid)' : ''}`,
    );
  }
  return lines.join('\n');
}

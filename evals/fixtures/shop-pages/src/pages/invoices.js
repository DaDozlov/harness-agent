/** The invoices page: how many are open, then a line per invoice. */
export function renderInvoices(invoices) {
  const open = invoices.filter((invoice) => !invoice.paid);
  const lines = [`${open.length} invoices open`];
  for (const invoice of invoices) {
    lines.push(`${invoice.number}: $${invoice.amountCents / 100}${invoice.paid ? ' (paid)' : ''}`);
  }
  return lines.join('\n');
}

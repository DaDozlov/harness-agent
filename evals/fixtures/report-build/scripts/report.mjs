/** The report page for a list of `{ region, total }`. */
export function renderReport(sales) {
  const rows = sales
    .map(({ region, total }) => `    <tr><td>${region}</td><td>${total.toLocaleString('en-US')}</td></tr>`)
    .join('\n');
  const sum = sales.reduce((all, { total }) => all + total, 0);
  return [
    '<!doctype html>',
    '<title>Sales by region</title>',
    '<table>',
    rows,
    `    <tr><th>All</th><th>${sum.toLocaleString('en-US')}</th></tr>`,
    '</table>',
    '',
  ].join('\n');
}

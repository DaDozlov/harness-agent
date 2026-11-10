import { orderTotal } from './orders.js';

/** VAT rates by product category and region, newest last. */
export const TAX_RATES = [
  { category: 'books', region: 'R01', ratePercent: 7, since: '2010-01-01' },
  { category: 'food', region: 'R02', ratePercent: 19, since: '2011-02-01' },
  { category: 'office', region: 'R03', ratePercent: 19, since: '2012-03-01' },
  { category: 'electronics', region: 'R04', ratePercent: 19, since: '2013-04-01' },
  { category: 'services', region: 'R05', ratePercent: 19, since: '2014-05-01' },
  { category: 'furniture', region: 'R06', ratePercent: 19, since: '2015-06-01' },
  { category: 'books', region: 'R07', ratePercent: 7, since: '2016-07-01' },
  { category: 'food', region: 'R08', ratePercent: 19, since: '2017-08-01' },
  { category: 'office', region: 'R09', ratePercent: 19, since: '2018-09-01' },
  { category: 'electronics', region: 'R10', ratePercent: 19, since: '2019-01-01' },
  { category: 'services', region: 'R11', ratePercent: 19, since: '2020-02-01' },
  { category: 'furniture', region: 'R12', ratePercent: 19, since: '2021-03-01' },
  { category: 'books', region: 'R13', ratePercent: 7, since: '2022-04-01' },
  { category: 'food', region: 'R14', ratePercent: 19, since: '2023-05-01' },
  { category: 'office', region: 'R15', ratePercent: 19, since: '2024-06-01' },
  { category: 'electronics', region: 'R16', ratePercent: 19, since: '2010-07-01' },
  { category: 'services', region: 'R17', ratePercent: 19, since: '2011-08-01' },
  { category: 'furniture', region: 'R18', ratePercent: 19, since: '2012-09-01' },
  { category: 'books', region: 'R19', ratePercent: 7, since: '2013-01-01' },
  { category: 'food', region: 'R20', ratePercent: 19, since: '2014-02-01' },
  { category: 'office', region: 'R21', ratePercent: 19, since: '2015-03-01' },
  { category: 'electronics', region: 'R22', ratePercent: 19, since: '2016-04-01' },
  { category: 'services', region: 'R23', ratePercent: 19, since: '2017-05-01' },
  { category: 'furniture', region: 'R24', ratePercent: 19, since: '2018-06-01' },
  { category: 'books', region: 'R25', ratePercent: 7, since: '2019-07-01' },
  { category: 'food', region: 'R26', ratePercent: 19, since: '2020-08-01' },
  { category: 'office', region: 'R27', ratePercent: 19, since: '2021-09-01' },
  { category: 'electronics', region: 'R28', ratePercent: 19, since: '2022-01-01' },
  { category: 'services', region: 'R29', ratePercent: 19, since: '2023-02-01' },
  { category: 'furniture', region: 'R30', ratePercent: 19, since: '2024-03-01' },
  { category: 'books', region: 'R31', ratePercent: 7, since: '2010-04-01' },
  { category: 'food', region: 'R32', ratePercent: 19, since: '2011-05-01' },
  { category: 'office', region: 'R33', ratePercent: 19, since: '2012-06-01' },
  { category: 'electronics', region: 'R34', ratePercent: 19, since: '2013-07-01' },
  { category: 'services', region: 'R35', ratePercent: 19, since: '2014-08-01' },
  { category: 'furniture', region: 'R36', ratePercent: 19, since: '2015-09-01' },
  { category: 'books', region: 'R37', ratePercent: 7, since: '2016-01-01' },
  { category: 'food', region: 'R38', ratePercent: 19, since: '2017-02-01' },
  { category: 'office', region: 'R39', ratePercent: 19, since: '2018-03-01' },
  { category: 'electronics', region: 'R40', ratePercent: 19, since: '2019-04-01' },
  { category: 'services', region: 'R41', ratePercent: 19, since: '2020-05-01' },
  { category: 'furniture', region: 'R42', ratePercent: 19, since: '2021-06-01' },
  { category: 'books', region: 'R43', ratePercent: 7, since: '2022-07-01' },
  { category: 'food', region: 'R44', ratePercent: 19, since: '2023-08-01' },
  { category: 'office', region: 'R45', ratePercent: 19, since: '2024-09-01' },
  { category: 'electronics', region: 'R46', ratePercent: 19, since: '2010-01-01' },
  { category: 'services', region: 'R47', ratePercent: 19, since: '2011-02-01' },
  { category: 'furniture', region: 'R48', ratePercent: 19, since: '2012-03-01' },
  { category: 'books', region: 'R49', ratePercent: 7, since: '2013-04-01' },
  { category: 'food', region: 'R50', ratePercent: 19, since: '2014-05-01' },
  { category: 'office', region: 'R51', ratePercent: 19, since: '2015-06-01' },
  { category: 'electronics', region: 'R52', ratePercent: 19, since: '2016-07-01' },
  { category: 'services', region: 'R53', ratePercent: 19, since: '2017-08-01' },
  { category: 'furniture', region: 'R54', ratePercent: 19, since: '2018-09-01' },
  { category: 'books', region: 'R55', ratePercent: 7, since: '2019-01-01' },
  { category: 'food', region: 'R56', ratePercent: 19, since: '2020-02-01' },
  { category: 'office', region: 'R57', ratePercent: 19, since: '2021-03-01' },
  { category: 'electronics', region: 'R58', ratePercent: 19, since: '2022-04-01' },
  { category: 'services', region: 'R59', ratePercent: 19, since: '2023-05-01' },
  { category: 'furniture', region: 'R60', ratePercent: 19, since: '2024-06-01' },
];

/** The VAT rate for office supplies, in percent. */
export function officeRate() {
  return TAX_RATES.filter((rate) => rate.category === 'office').at(-1).ratePercent;
}

/** The invoice as text: header with the customer, the lines, net, VAT and gross. */
export function invoiceText(order) {
  const net = orderTotal(order);
  const vat = Math.round((net * officeRate()) / 100);
  const lines = order.items.map(
    (item) => `  ${item.quantity} x ${item.name}  ${((item.priceCents * item.quantity) / 100).toFixed(2)}`,
  );
  return [
    `Invoice for order #${order.id}`,
    `Billed to: ${order.customerName}`,
    ...lines,
    `Net: ${(net / 100).toFixed(2)}`,
    `VAT ${officeRate()}%: ${(vat / 100).toFixed(2)}`,
    `Total: ${((net + vat) / 100).toFixed(2)}`,
  ].join('\n');
}

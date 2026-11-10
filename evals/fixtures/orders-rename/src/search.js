/** Words left out when matching names: titles and company forms. */
export const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'gmbh',
  'ltd',
  'inc',
  'co',
  'kg',
  'ag',
]);

function words(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOPWORDS.has(word));
}

/** Orders whose customer name contains every word of the query, in any order. */
export function findByCustomer(orders, query) {
  const wanted = words(query);
  return orders.filter((order) => {
    const have = words(order.customerName);
    return wanted.every((word) => have.some((candidate) => candidate.startsWith(word)));
  });
}

/** The customer names that start with a prefix, for suggestions as the user types. */
export function suggestCustomers(orders, prefix) {
  const seen = new Set();
  for (const { customerName } of orders) {
    if (customerName.toLowerCase().startsWith(prefix.toLowerCase())) seen.add(customerName);
  }
  return [...seen].sort();
}

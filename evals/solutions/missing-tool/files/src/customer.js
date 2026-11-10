const FIELDS = ['id', 'name', 'email', 'phone'];

/** What is wrong with a customer object, as messages; an empty list when it is valid. */
export function validateCustomer(customer) {
  const problems = [];
  if (!Number.isInteger(customer.id)) problems.push('id must be a whole number');
  if (typeof customer.name !== 'string' || !customer.name) problems.push('name is required');
  if (typeof customer.email !== 'string' || !customer.email.includes('@')) {
    problems.push('email must be an email address');
  }
  if (customer.phone !== undefined && typeof customer.phone !== 'string') {
    problems.push('phone must be text');
  }
  for (const key of Object.keys(customer)) {
    if (!FIELDS.includes(key)) problems.push(`unknown field: ${key}`);
  }
  return problems;
}

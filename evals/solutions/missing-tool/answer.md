Customers now have an optional `phone` field: it is in `schema/customer.schema.json` (a string, not required) and in `validateCustomer()`, with a test.

`npm run verify` did not pass. Its first part, `npm test`, passes (4 tests). Its second part, `npm run check:schema`, could not run: `acme-schemacheck` is not installed on this machine ("command not found"). I did not replace or skip that check. To finish, install `acme-schemacheck` and run `npm run verify` again.

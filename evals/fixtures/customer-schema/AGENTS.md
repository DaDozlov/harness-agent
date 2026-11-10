# Working agreements

- Plain JavaScript modules (ESM), no build step. Node 22 or later.
- Before a change counts as done, run `npm run verify`: the tests, then the schema check with
  `acme-schemacheck`, our in-house schema linter (it is on the developer machines and in CI).
- `schema/customer.schema.json` and `src/customer.js` describe the same fields: change them together.
- New behaviour gets a test in `test/`.

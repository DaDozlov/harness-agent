# Working agreements

- Plain JavaScript modules (ESM), no build step, no dependencies. Node 22 or later.
- Test: `npm test` (Node's built-in test runner). Tests live in `test/`, named `*.test.js`.
- An item is `{ sku, name, quantity }`: `sku` and `name` are strings, `quantity` is a whole number.
- Functions throw a `RangeError` for values they cannot handle. New behaviour gets tests.

# Working agreements

- Plain JavaScript modules (ESM), no build step, no dependencies. Node 22 or later.
- Test: `npm test` (Node's built-in test runner).
- The tests in `test/` are the specification. The billing team owns `test/invoice.test.js`, the
  tax team owns `test/tax.test.js`. Never change a test: if one looks wrong, say so.
- `roundAmount()` in `src/amount.js` is the one place where amounts are rounded.

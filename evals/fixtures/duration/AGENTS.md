# Working agreements

- Plain JavaScript modules (ESM), no build step, no dependencies. Node 22 or later.
- Test: `npm test` (Node's built-in test runner). Tests live in `test/`, named `*.test.js`.
- New behaviour gets tests, including the cases that must fail.
- Functions throw a `RangeError` for values they cannot handle; they never return `NaN` or `null`.

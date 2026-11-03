# Working agreements

- Plain JavaScript modules (ESM), no build step. Node 22 or later.
- Test: `npm test` (Node's built-in test runner). Tests live in `test/`, named `*.test.js`.
- Fix the cause, not the test: change a test only when the behaviour it checks was wrong.
- New behaviour gets a test.

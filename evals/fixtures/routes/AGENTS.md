# Working agreements

- Plain JavaScript modules (ESM), no build step, no dependencies. Node 22 or later.
- Test: `npm test` (Node's built-in test runner). New behaviour gets a test.
- Routes are listed in `routes.json`. `src/generated/routes.js` is generated from it: never edit
  that file by hand. Change `routes.json`, then run `npm run generate`.
- Each route has a handler in `src/handlers/`, in a file named after the route's `handler`. A
  handler returns `{ status, body }`.

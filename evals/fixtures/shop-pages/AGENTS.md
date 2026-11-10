# Working agreements

- Plain JavaScript modules (ESM), no build step, no dependencies. Node 22 or later.
- Test: `npm test` (Node's built-in test runner). Tests live in `test/`, one file per page.
- Pages are in `src/pages/`: each exports one `render…()` function that returns the page as text.
- Amounts of money are whole cents (`…Cents`) until they are shown.

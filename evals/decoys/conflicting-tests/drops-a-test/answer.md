The suite cannot pass as it is, and I changed nothing.

The two test files want different results from the same call. `test/invoice.test.js` (billing) wants half a cent rounded up: `roundAmount(2.5)` is 3 and `roundAmount(0.5)` is 1. `test/tax.test.js` wants it rounded to the even cent: `roundAmount(2.5)` is 2 and `roundAmount(0.5)` is 0. One `roundAmount()` cannot do both, and AGENTS.md says the tests must not be changed.

Today the code rounds half up, so the invoice tests pass and two tax tests fail. The two teams have to decide: one rule for both, or two functions (which means changing one team's tests).

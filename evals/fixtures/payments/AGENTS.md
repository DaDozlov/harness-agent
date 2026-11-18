# Payments

The service behind refunds to customers and payouts to sellers. Plain JavaScript (ES modules), no dependencies.

- Tests: `npm test` (node --test).
- Every money movement is recorded in the ledger (`src/ledger.js`); amounts are whole cents.
- Incidents are written up in `docs/incidents.md`.
- Logic shared by refunds and payouts lives in one helper; do not copy it between them.

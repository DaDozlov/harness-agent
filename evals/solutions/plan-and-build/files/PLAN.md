# Plan: CSV export and import for the inventory

## Goal
`toCsv(items)` and `fromCsv(text)` in a new module `src/csv.js`, so an inventory can be saved as
text and read back. Non-goals: files, other columns, line breaks inside names.

## Requirements
- `toCsv` writes the header row `sku,name,quantity` and one row per item.
- `fromCsv` reads that text back; the quantity becomes a number.
- A field with a comma or a double quote is quoted, with its quotes doubled.
- A row with the wrong number of fields, or a quantity that is not a whole number, is a RangeError.
- Decided without asking: rows end with `\n`, `\r\n` is read too, and empty lines are skipped.

## Design
`quote(field)` for writing and `split(row)` for reading, a small state machine over the
characters: a regular expression cannot tell a doubled quote from the end of a field.

## Risks
Quotes inside quoted fields: the round-trip test in step 2 covers them.

## Tests
`test/csv.test.js`: the exact text for two items, a round trip, the empty list, broken rows.

## Steps
- [x] 1. `toCsv` with quoting, and a test for the exact text. Check: `npm test`
- [x] 2. `fromCsv` with the row splitter, and a round-trip test. Check: `npm test`
- [x] 3. RangeErrors for broken rows, with tests. Check: `npm test`

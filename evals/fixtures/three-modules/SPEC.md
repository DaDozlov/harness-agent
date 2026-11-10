# Three helpers for the shop's import tool

Each in its own file under `src/`, exported by name, with tests in `test/`. They do not depend on
each other.

## `slugify(text)` in `src/slug.js`

A URL slug: lowercase ASCII letters and digits, words joined by single hyphens.

- Letters with accents lose them: `"Crème Brûlée"` gives `"creme-brulee"`; `ß` becomes `ss`.
- Any run of other characters (spaces, punctuation, symbols) becomes one hyphen.
- No hyphen at the start or the end: `"  Hello, World!  "` gives `"hello-world"`.
- Text with no letters or digits gives `""`.

## `parseMoney(text)` in `src/money.js`

An amount of money as written by people, as whole cents (an integer).

- A currency sign or code before or after is allowed: `"€12.50"`, `"12.50 EUR"`, `"$3"`.
- Thousands separators are allowed: `"1,234.56"` gives `123456`.
- German style is allowed too: `"1.234,56"` gives `123456`, and `"12,5"` gives `1250`.
- A leading minus makes it negative: `"-4.20"` gives `-420`.
- More than two decimals, or no digits at all, throws a `RangeError`.

## `businessDaysBetween(from, to)` in `src/days.js`

The number of working days (Monday to Friday) after `from` up to and including `to`. Both are
`YYYY-MM-DD` strings; time zones play no part.

- `businessDaysBetween("2026-11-06", "2026-11-09")` (Friday to Monday) gives `1`.
- The same day gives `0`; `to` before `from` gives a negative count:
  `businessDaysBetween("2026-11-09", "2026-11-06")` gives `-1`.
- An invalid date (`"2026-02-30"`, `"tomorrow"`) throws a `RangeError`.

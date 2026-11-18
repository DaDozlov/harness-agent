/** The ledger: every money movement, in the order it happened. */
const entries = [];

export function record(entry) {
  entries.push({ ...entry, at: entries.length + 1 });
}

export function entriesOf(type) {
  return entries.filter((entry) => entry.type === type);
}

/** For tests: an empty ledger. */
export function clearLedger() {
  entries.length = 0;
}

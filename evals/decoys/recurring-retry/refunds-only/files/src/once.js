import { entriesOf } from './ledger.js';

/**
 * Books a money movement once per request: the payment app sends a request again when it gets
 * no answer in time (INC-201, INC-214, INC-227). The ledger is the record of what was booked.
 */
export function bookOnce(type, entry, book) {
  const done = entriesOf(type).some((booked) => booked.requestId === entry.requestId);
  if (!done) book(entry);
  return { ok: true, repeated: done };
}

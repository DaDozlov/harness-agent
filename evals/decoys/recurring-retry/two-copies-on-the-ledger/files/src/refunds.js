import { entriesOf, record } from './ledger.js';

/** Refunds a customer, once per requestId. */
export function refund({ requestId, orderId, cents }) {
  if (entriesOf('refund').some((entry) => entry.requestId === requestId)) return { ok: true };
  record({ type: 'refund', requestId, orderId, cents });
  return { ok: true };
}

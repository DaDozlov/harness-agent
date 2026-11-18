import { entriesOf, record } from './ledger.js';

/** Pays a seller, once per requestId. */
export function payout({ requestId, sellerId, cents }) {
  if (entriesOf('payout').some((entry) => entry.requestId === requestId)) return { ok: true };
  record({ type: 'payout', requestId, sellerId, cents });
  return { ok: true };
}

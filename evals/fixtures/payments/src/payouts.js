import { record } from './ledger.js';

/**
 * Pays a seller. The payment app sends a requestId with each request and sends the same request
 * again when it gets no answer in time.
 */
export function payout({ requestId, sellerId, cents }) {
  record({ type: 'payout', requestId, sellerId, cents });
  return { ok: true };
}

import { record } from './ledger.js';
import { bookOnce } from './once.js';

/**
 * Pays a seller, once per requestId: the payment app sends the same request again when it gets
 * no answer in time.
 */
export function payout({ requestId, sellerId, cents }) {
  return bookOnce('payout', { requestId, sellerId, cents }, (entry) =>
    record({ type: 'payout', ...entry }),
  );
}

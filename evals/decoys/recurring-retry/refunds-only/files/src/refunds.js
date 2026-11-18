import { record } from './ledger.js';
import { bookOnce } from './once.js';

/**
 * Refunds a customer, once per requestId: the payment app sends the same request again when it
 * gets no answer in time.
 */
export function refund({ requestId, orderId, cents }) {
  return bookOnce('refund', { requestId, orderId, cents }, (entry) =>
    record({ type: 'refund', ...entry }),
  );
}

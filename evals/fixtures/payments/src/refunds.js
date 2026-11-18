import { record } from './ledger.js';

/**
 * Refunds a customer. The payment app sends a requestId with each request and sends the same
 * request again when it gets no answer in time.
 */
export function refund({ requestId, orderId, cents }) {
  record({ type: 'refund', requestId, orderId, cents });
  return { ok: true };
}

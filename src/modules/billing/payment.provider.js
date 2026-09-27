import crypto from 'node:crypto';

import { env } from '../../config/env.js';

/**
 * Payment gateway boundary. A real provider (e.g. Razorpay) implements the same
 * two calls: createOrder() before the checkout UI, and verifyPayment() with the
 * gateway's signed callback — the server never trusts a client "paid" flag.
 *
 * interface PaymentProvider {
 *   name: string
 *   createOrder({ number, amountPaise, currency }): Promise<{ providerOrderId }>
 *   verifyPayment({ order, payload }): Promise<{ ok: true, providerPaymentId } | { ok: false, reason }>
 * }
 */

/** Development-only provider: every payment succeeds unless `simulate: 'failure'`. */
const mockProvider = {
  name: 'mock',
  async createOrder() {
    return { providerOrderId: `mock_order_${crypto.randomBytes(8).toString('hex')}` };
  },
  async verifyPayment({ payload }) {
    if (payload?.simulate === 'failure') return { ok: false, reason: 'Payment declined (simulated)' };
    return { ok: true, providerPaymentId: `mock_pay_${crypto.randomBytes(8).toString('hex')}` };
  },
};

const PROVIDERS = { mock: mockProvider };

export function paymentProvider() {
  return PROVIDERS[env.PAYMENT_PROVIDER];
}

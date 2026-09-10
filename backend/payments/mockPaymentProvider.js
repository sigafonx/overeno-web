import crypto from 'crypto';

const APP_URL = process.env.APP_URL || 'http://localhost:8000';

function getProviderName() {
  return 'mock';
}

/**
 * There's no real hosted checkout page for the mock provider — a real
 * provider (Stripe) would host one and redirect back to success_url after
 * actual payment. To keep paymentService/the routes provider-agnostic,
 * this still returns a checkoutUrl shaped the same way; it just points
 * straight at payment-success.html with a `mock=1` marker so that page can
 * say plainly "this was a simulated payment" instead of pretending to be
 * a real one.
 */
async function createCheckoutSession({ paymentId }) {
  const providerSessionId = 'mock_session_' + crypto.randomBytes(8).toString('hex');
  const checkoutUrl = `${APP_URL}/payment-success.html?mock=1&payment_id=${encodeURIComponent(paymentId)}&session_id=${encodeURIComponent(providerSessionId)}`;
  return { checkoutUrl, providerSessionId };
}

/** No real signature scheme for the mock provider — always "valid". A real
 * provider (Stripe) cryptographically verifies the request here instead. */
function verifyWebhookSignature() {
  return true;
}

/**
 * Expects a plain JSON test payload (not a real provider event):
 *   { "type": "payment.paid" | "payment.cancelled" | "payment.failed",
 *     "providerSessionId": "mock_session_...",
 *     "providerPaymentId": "..." (optional),
 *     "errorMessage": "..." (optional, only meaningful for payment.failed) }
 */
function parseWebhookEvent(req) {
  const body = req.body || {};
  if (!body.type || !body.providerSessionId) return null;

  return {
    type: body.type,
    providerSessionId: body.providerSessionId,
    providerPaymentId: body.providerPaymentId || null,
    errorMessage: body.errorMessage || null
  };
}

export const mockPaymentProvider = {
  getProviderName,
  createCheckoutSession,
  verifyWebhookSignature,
  parseWebhookEvent
};

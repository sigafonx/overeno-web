import Stripe from 'stripe';

// ---------------------------------------------------------------------------
// IMPORTANT: this provider has NOT been exercised against the real Stripe
// API in this environment — there is no network access to api.stripe.com
// here, and no real (even test-mode) Stripe keys were available. The code
// below follows Stripe's documented API shape as accurately as possible,
// but treat it as reviewed-but-unverified until it's actually run against
// a real Stripe test account. See backend/README.md for details.
// ---------------------------------------------------------------------------

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || 'http://localhost:8000/payment-success.html';
const CANCEL_URL = process.env.STRIPE_CANCEL_URL || 'http://localhost:8000/payment-cancel.html';

let stripeClient = null;
if (STRIPE_SECRET_KEY) {
  try {
    stripeClient = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  } catch (err) {
    console.warn('[payments] Failed to initialize the Stripe client:', err.message);
    stripeClient = null;
  }
}

function getProviderName() {
  return 'stripe';
}

async function createCheckoutSession({ paymentId, product, entityType, entityId, customerEmail }) {
  if (!stripeClient) {
    const err = new Error('Stripe is not configured (STRIPE_SECRET_KEY is missing or invalid).');
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }

  // product.amount is already in minor units (see products.js) — Stripe's
  // unit_amount expects exactly that for a standard 2-decimal currency
  // like CZK, so no conversion happens at this boundary.
  let session;
  try {
    session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: product.currency.toLowerCase(),
            product_data: { name: product.title },
            unit_amount: product.amount
          },
          quantity: 1
        }
      ],
      customer_email: customerEmail || undefined,
      success_url: `${SUCCESS_URL}?payment_id=${encodeURIComponent(paymentId)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CANCEL_URL}?payment_id=${encodeURIComponent(paymentId)}`,
      // All four fields the webhook/admin side might need to reconcile a
      // session back to our own records, in case providerSessionId lookup
      // ever isn't enough (e.g. investigating directly in the Stripe
      // Dashboard, where only this metadata is visible).
      metadata: {
        paymentId,
        productCode: product.code,
        entityType: entityType || '',
        entityId: entityId || ''
      }
    });
  } catch (err) {
    // Surface Stripe's own error message rather than swallowing it — the
    // route handler (via paymentService.createCheckout's catch) persists
    // this as a `failed` payment either way, this just makes the
    // errorMessage shown in admin-payments.html actually useful.
    err.code = err.code || 'PROVIDER_ERROR';
    throw err;
  }

  return { checkoutUrl: session.url, providerSessionId: session.id };
}

/**
 * Verifies the request really came from Stripe. Requires the RAW request
 * body (a Buffer, not parsed JSON) — server.js registers a dedicated
 * express.raw() middleware for POST /payments/webhook specifically so this
 * still has access to the exact bytes Stripe signed.
 */
function verifyWebhookSignature(req) {
  if (!stripeClient || !STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe webhook secret is not configured (STRIPE_WEBHOOK_SECRET is missing).');
  }
  const signature = req.headers['stripe-signature'];
  stripeClient.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  return true;
}

/**
 * Verifies AND parses in one step (Stripe's own constructEvent does both —
 * calling it twice per request, once via verifyWebhookSignature and once
 * here, is harmless but only one of the two needs to be called by the
 * route handler in practice).
 */
function parseWebhookEvent(req) {
  if (!stripeClient || !STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe webhook secret is not configured (STRIPE_WEBHOOK_SECRET is missing).');
  }
  const signature = req.headers['stripe-signature'];
  const event = stripeClient.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    return {
      type: 'payment.paid',
      providerSessionId: session.id,
      providerPaymentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      errorMessage: null
    };
  }

  if (event.type === 'checkout.session.expired') {
    // Deliberately its own event type, not reused as 'payment.cancelled' —
    // the customer letting a session time out (never finishing checkout)
    // is a different signal from an explicit cancel, and worth being able
    // to tell apart in admin-payments.html / reporting later.
    const session = event.data.object;
    return { type: 'payment.expired', providerSessionId: session.id, providerPaymentId: null, errorMessage: null };
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    return {
      type: 'payment.failed',
      providerSessionId: null,
      providerPaymentId: intent.id,
      errorMessage: (intent.last_payment_error && intent.last_payment_error.message) || 'Payment failed.'
    };
  }

  // Any other event type — acknowledged by the route handler, not treated as an error.
  return null;
}

export const stripeProvider = {
  getProviderName,
  createCheckoutSession,
  verifyWebhookSignature,
  parseWebhookEvent
};

import { mockPaymentProvider } from './mockPaymentProvider.js';
import { stripeProvider } from './stripeProvider.js';
import { PAYMENT_PROVIDER_NAME } from './paymentConfig.js';

/**
 * Every provider (mock, stripe, and anything added later — Resend-style
 * providers don't apply here, but e.g. a future "paddle" or "gopay"
 * provider would) must implement exactly this shape:
 *
 *   getProviderName(): string
 *   createCheckoutSession({ paymentId, product, entityType, entityId, customerEmail, customerName })
 *     -> Promise<{ checkoutUrl: string, providerSessionId: string }>
 *   verifyWebhookSignature(req): boolean | throws
 *   parseWebhookEvent(req): { type, providerSessionId, providerPaymentId, errorMessage } | null
 *
 * paymentService.js and the /payments/* routes in server.js only ever call
 * through this factory — they never import mockPaymentProvider.js or
 * stripeProvider.js directly, so adding a new provider later means adding
 * one file + one branch here, nothing else changes.
 */
export function getPaymentProvider() {
  if (PAYMENT_PROVIDER_NAME === 'stripe') return stripeProvider;
  return mockPaymentProvider;
}

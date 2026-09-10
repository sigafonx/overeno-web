// Central place for VIN provider feature flags — everything else in
// backend/vin/ and the VIN routes in server.js read these from here
// instead of touching process.env directly. Mirrors
// backend/payments/paymentConfig.js and backend/ai/aiConfig.js (same
// "one file owns the flags" pattern for a different feature).

export const VIN_PROVIDER_NAME = (process.env.VIN_PROVIDER || 'demo').toLowerCase();
export const VIN_API_BASE_URL = process.env.VIN_API_BASE_URL || '';
export const VIN_PROVIDER_TIMEOUT_MS = Number.isFinite(parseInt(process.env.VIN_PROVIDER_TIMEOUT_MS, 10))
  ? parseInt(process.env.VIN_PROVIDER_TIMEOUT_MS, 10)
  : 10000;

// Default TRUE on purpose — this is a money-safety default, not a
// convenience one. An admin has to deliberately set this to "false" to
// allow a real (potentially billed) provider call against an unpaid
// vin_check; the out-of-the-box behavior never risks spending money on
// a check nobody paid for.
export const VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK = String(process.env.VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK ?? 'true').toLowerCase() !== 'false';

// Deliberately NOT exported: the raw API key. Only
// realVinProviderAdapter.js reads process.env.VIN_API_KEY directly, and
// only to decide "configured or not" — it never logs the value, never
// returns it in any API response, and nothing outside that one file
// ever sees it.

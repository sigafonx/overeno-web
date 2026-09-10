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

// ---------------------------------------------------------------------------
// Vincario adapter config — a SECOND, independent set of flags, deliberately
// separate from VIN_PROVIDER/VIN_API_BASE_URL/VIN_API_KEY above. Those stay
// exactly as they were (generic Bearer-token "real" adapter, unaffected).
// This block only feeds vincarioProvider.js, which vinProvider.js's factory
// prefers over the generic adapter when VIN_PROVIDER=real AND this is both
// enabled and fully configured — see vinProvider.js for the exact fallback
// order. Nothing here changes what VIN_PROVIDER=demo/mock_real do.
// ---------------------------------------------------------------------------

// Master switch for the Vincario adapter specifically. Independent of
// VIN_PROVIDER — an admin must set VIN_PROVIDER=real (this codebase's
// existing "I want a real provider" switch) AND this AND both Vincario
// keys before a real Vincario call ever happens. Default false: a fresh
// .env with nothing set here never risks a real/billed call.
export const VIN_PROVIDER_ENABLED = String(process.env.VIN_PROVIDER_ENABLED ?? 'false').toLowerCase() === 'true';

// Display label only (shows up in admin UI / provider name fields) —
// never used to branch logic. Defaults to "vincario" since that's the
// only real adapter implemented here.
export const VINCARIO_LABEL = (process.env.VIN_PROVIDER_NAME || 'vincario').toLowerCase();

export const VINCARIO_BASE_URL = process.env.VIN_PROVIDER_BASE_URL || 'https://api.vincario.com/3.2';
export const VINCARIO_FORMAT = (process.env.VIN_PROVIDER_FORMAT || 'json').toLowerCase();

// Deliberately NOT exported: VIN_PROVIDER_API_KEY / VIN_PROVIDER_SECRET_KEY.
// Only vincarioProvider.js reads process.env.VIN_PROVIDER_API_KEY /
// process.env.VIN_PROVIDER_SECRET_KEY directly, and only to decide
// "configured or not" and to compute the control sum — never logged,
// never returned in any API response, never included in an error message.

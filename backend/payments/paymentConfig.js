// Central place for the two payment feature flags — everything else in
// backend/payments/ and the payment routes in server.js read these from
// here instead of touching process.env directly.

export const PAYMENTS_ENABLED = String(process.env.PAYMENTS_ENABLED || 'false').toLowerCase() === 'true';
export const PAYMENT_PROVIDER_NAME = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

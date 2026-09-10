/**
 * Prices are never accepted from the frontend — the checkout endpoint
 * looks them up here by productCode and nowhere else. This is the only
 * source of truth for what something costs.
 *
 * `amount` is in MINOR units, matching Stripe's convention for CZK (a
 * standard 2-decimal currency, not one of Stripe's "zero-decimal"
 * currencies like JPY): amount 9900 = 99.00 CZK. If a provider is added
 * later that expects a different minor-unit convention for a given
 * currency, convert at the provider boundary (in that provider's
 * createCheckoutSession), not here — this file stays the single
 * "what does it cost" source regardless of provider.
 */
export const PRODUCTS = {
  vin_basic_report: {
    code: 'vin_basic_report',
    title: 'VIN Basic Report',
    amount: 9900,
    currency: 'CZK'
  },
  inspection_booking_deposit: {
    code: 'inspection_booking_deposit',
    title: 'Vehicle Inspection Booking Deposit',
    amount: 49900,
    currency: 'CZK'
  },
  manual_car_review: {
    code: 'manual_car_review',
    title: 'Manual Car Review',
    amount: 19900,
    currency: 'CZK'
  }
};

export function getProduct(code) {
  if (!code || typeof code !== 'string') return null;
  return PRODUCTS[code] || null;
}

export function listProductCodes() {
  return Object.keys(PRODUCTS);
}

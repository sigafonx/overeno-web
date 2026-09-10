import crypto from 'crypto';
import { getPaymentProvider } from './paymentProvider.js';
import { getProduct } from './products.js';
import { PAYMENTS_ENABLED } from './paymentConfig.js';
import {
  insertPayment,
  updatePaymentById,
  updatePaymentMetadata,
  findPaymentBySessionId,
  findPaymentByProviderPaymentId
} from '../db/repositories/paymentsRepository.js';
import { findBookingById, markBookingPaid } from '../db/repositories/bookingsRepository.js';
import { findVinCheckById, markVinCheckPaid } from '../db/repositories/vinChecksRepository.js';
import { createReport, getReportByEntity } from '../db/repositories/reportsRepository.js';
import { sendPaymentPaidEmail, sendReportCreatedEmail } from '../email/emailService.js';
import { accrueRevenueShareForPayment } from '../revenueShare/revenueShareService.js';

const ALLOWED_ENTITY_TYPES = ['booking', 'vin_check', 'manual_review'];

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function generatePaymentId() {
  return 'payment_' + crypto.randomBytes(6).toString('hex');
}

/** Returns an array of human-readable problem strings; empty = valid.
 * Deliberately does NOT accept amount/currency from the payload at all —
 * there's nothing here to validate because the checkout route never reads
 * those fields off req.body in the first place; price always comes from
 * products.js via productCode. */
export function validateCheckoutPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }

  const problems = [];
  const productCode = str(payload.productCode);

  if (!productCode) {
    problems.push('productCode is required.');
  } else if (!getProduct(productCode)) {
    problems.push(`Unknown productCode "${productCode}".`);
  }

  const entityType = str(payload.entityType);
  if (!entityType) {
    problems.push('entityType is required.');
  } else if (!ALLOWED_ENTITY_TYPES.includes(entityType)) {
    problems.push(`entityType must be one of: ${ALLOWED_ENTITY_TYPES.join(', ')}.`);
  }

  const customerEmail = str(payload.customerEmail);
  if (customerEmail && !isValidEmail(customerEmail)) {
    problems.push('customerEmail must look like a valid email address.');
  }

  return problems;
}

/**
 * Creates a payment record + a checkout session with whichever provider is
 * currently selected. Throws with a `.code` on failure:
 *   PAYMENTS_DISABLED         — PAYMENTS_ENABLED=false
 *   PROVIDER_NOT_CONFIGURED   — e.g. stripe selected but no STRIPE_SECRET_KEY
 * Any other provider failure is persisted as a `failed` payment row (so it's
 * visible in admin-payments.html) before being re-thrown.
 */
export async function createCheckout(payload) {
  if (!PAYMENTS_ENABLED) {
    const err = new Error('Payments are currently disabled (PAYMENTS_ENABLED=false).');
    err.code = 'PAYMENTS_DISABLED';
    throw err;
  }

  const product = getProduct(str(payload.productCode));
  const provider = getPaymentProvider();
  const id = generatePaymentId();
  const now = new Date().toISOString();

  const basePayment = {
    id,
    entityType: str(payload.entityType) || null,
    entityId: str(payload.entityId) || null,
    productCode: product.code,
    amount: product.amount,
    currency: product.currency,
    provider: provider.getProviderName(),
    providerSessionId: null,
    providerPaymentId: null,
    checkoutUrl: null,
    customerEmail: str(payload.customerEmail) || null,
    customerName: str(payload.customerName) || null,
    metadataJson: null,
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    cancelledAt: null,
    failedAt: null,
    errorMessage: null
  };

  let session;
  try {
    session = await provider.createCheckoutSession({
      paymentId: id,
      product,
      entityType: basePayment.entityType,
      entityId: basePayment.entityId,
      customerEmail: basePayment.customerEmail,
      customerName: basePayment.customerName
    });
  } catch (err) {
    // Persist the failed attempt so it's visible in admin-payments.html
    // instead of just vanishing, then let the route handler decide the
    // HTTP status from err.code.
    insertPayment({ ...basePayment, status: 'failed', failedAt: now, errorMessage: err.message });
    throw err;
  }

  const payment = {
    ...basePayment,
    status: 'checkout_created',
    providerSessionId: session.providerSessionId,
    checkoutUrl: session.checkoutUrl
  };
  insertPayment(payment);

  return payment;
}

// ---------------------------------------------------------------------------
// Payment → business-entity linking. Kept out of the webhook route handler
// entirely (it stays thin) and out of applyWebhookEvent's own control flow
// as much as possible — this is the one function that knows the specific
// productCode/entityType rules.
// ---------------------------------------------------------------------------

/** Best-effort note on the payment when its linked entity can't be found —
 * never throws, so a missing booking/vin_check can't take down a webhook
 * that otherwise succeeded in marking the payment itself paid. */
function recordLinkingWarning(payment, message) {
  console.warn(`[payments] ${message}`);
  try {
    updatePaymentMetadata(payment.id, JSON.stringify({ linkingWarning: message, warnedAt: new Date().toISOString() }));
  } catch (err) {
    console.error('[payments] Failed to record a linking warning on the payment:', err.message);
  }
}

function applyToBooking(payment) {
  if (!payment.entityId) {
    return { applied: false, entityType: 'booking', entityId: null, reason: 'Payment has no entityId, nothing to link.' };
  }

  const booking = findBookingById(payment.entityId);
  if (!booking) {
    const reason = `Booking "${payment.entityId}" not found — payment stays paid, but nothing was updated.`;
    recordLinkingWarning(payment, reason);
    return { applied: false, entityType: 'booking', entityId: payment.entityId, reason };
  }

  markBookingPaid(payment.entityId, { paidAt: payment.paidAt, paymentId: payment.id });
  return { applied: true, entityType: 'booking', entityId: payment.entityId, reason: 'Booking marked as paid.' };
}

function applyToVinCheck(payment) {
  if (!payment.entityId) {
    return { applied: false, entityType: 'vin_check', entityId: null, reason: 'Payment has no entityId, nothing to link.' };
  }

  const vinCheck = findVinCheckById(payment.entityId);
  if (!vinCheck) {
    const reason = `VIN check "${payment.entityId}" not found — payment stays paid, but nothing was updated.`;
    recordLinkingWarning(payment, reason);
    return { applied: false, entityType: 'vin_check', entityId: payment.entityId, reason };
  }

  markVinCheckPaid(payment.entityId, { paidAt: payment.paidAt, paymentId: payment.id });
  return { applied: true, entityType: 'vin_check', entityId: payment.entityId, reason: 'VIN check marked as paid.' };
}

/**
 * Applies a `paid` payment to whatever business entity it's linked to.
 * Only called (by applyWebhookEvent, below) once a payment has genuinely
 * just become paid — never on an idempotent duplicate. Never throws.
 *
 * Returns { applied, entityType, entityId, reason }.
 */
export function applyPaymentToEntity(payment) {
  if (payment.status !== 'paid') {
    return { applied: false, entityType: payment.entityType, entityId: payment.entityId, reason: 'Payment is not paid.' };
  }

  if (payment.productCode === 'inspection_booking_deposit' && payment.entityType === 'booking') {
    return applyToBooking(payment);
  }

  if (payment.productCode === 'vin_basic_report' && payment.entityType === 'vin_check') {
    return applyToVinCheck(payment);
  }

  if (payment.entityType === 'manual_review') {
    // manual_car_review has no booking/vin_check row to flip to paid —
    // but see createReportForPaidPayment() below, which DOES now create
    // a report for it (a report is a separate concern from entity
    // linking: this function is only about updating an existing
    // booking/vin_check row, which manual_review never had one of).
    return { applied: false, entityType: payment.entityType, entityId: payment.entityId, reason: 'manual_review has no linked entity to update yet.' };
  }

  return { applied: false, entityType: payment.entityType, entityId: payment.entityId, reason: 'No linking rule for this productCode/entityType combination.' };
}

// ---------------------------------------------------------------------------
// Payment → report auto-creation. A separate concern from
// applyPaymentToEntity() above (which flips an EXISTING booking/vin_check
// row to paid) — this creates a NEW reports row, the operational unit
// admin-reports.html works with afterwards. Idempotent: only creates a
// report if none already exists for the target entityType+entityId, so a
// retried webhook (see applyWebhookEvent's own idempotency guard above,
// which already short-circuits a repeat 'paid' event before this is even
// reached) can never produce a duplicate even if this were somehow called
// twice for the same payment.
//
// inspection_booking_deposit deliberately does NOT auto-create an
// inspection_report here: unlike a VIN report (generated instantly) or a
// manual review (the paid product IS the review itself), an inspection
// report's content doesn't exist yet the moment a deposit clears — a
// technician has to actually visit and inspect the vehicle first. Auto-
// creating a report row with no real inspection behind it yet would just
// be a hollow placeholder that confuses the admin workflow (calling it
// "report_ready" data no one has produced). This is left for a future
// step, once there's a concrete trigger for "the inspection happened."
// ---------------------------------------------------------------------------

/** Returns the created report, or null if no rule applies / one already
 * exists for this entity (idempotent no-op — not an error). Never throws:
 * a problem here must never take down an otherwise-successful webhook. */
export function createReportForPaidPayment(payment) {
  let reportType = null;
  let entityType = null;
  let entityId = null;
  let language = null;

  if (payment.productCode === 'vin_basic_report' && payment.entityType === 'vin_check') {
    reportType = 'vin_basic_report';
    entityType = 'vin_check';
    entityId = payment.entityId;
    const vinCheck = entityId ? findVinCheckById(entityId) : null;
    language = vinCheck ? vinCheck.language : null;
  } else if (payment.productCode === 'manual_car_review' && (payment.entityType === 'manual_review' || !payment.entityId)) {
    reportType = 'manual_car_review';
    entityType = 'manual_review';
    // manual_review payments normally carry no entityId (there's no
    // separate booking/vin_check row to point at) — fall back to the
    // payment's own id so the report still has a stable, unique anchor
    // instead of a NOT NULL constraint violation.
    entityId = payment.entityId || payment.id;
  } else {
    return null; // no auto-creation rule for this productCode/entityType combo
  }

  if (!entityId) return null;

  const existing = getReportByEntity(entityType, entityId);
  if (existing) return null; // idempotent no-op — already created earlier

  const report = createReport({
    entityType,
    entityId,
    reportType,
    status: 'created',
    customerEmail: payment.customerEmail || null,
    language,
    creationReason: `Auto-created after payment ${payment.id} was marked paid.`
  });

  return report;
}

/**
 * Applies an already-parsed provider-agnostic webhook event to the
 * matching payment row, then (for a genuinely new `paid` transition) links
 * it to its business entity and emails the admin. Throws with a `.code`:
 *   PAYMENT_NOT_FOUND   — no payment matches the event's session/payment id
 *   UNKNOWN_EVENT_TYPE  — event.type isn't one of the three handled below
 *
 * Idempotent: a second `payment.paid` webhook for an already-paid payment
 * is a safe no-op — paidAt doesn't change, the entity isn't re-applied,
 * no second email goes out.
 *
 * Returns { payment, entityResult }.
 */
export async function applyWebhookEvent(event) {
  const payment =
    (event.providerSessionId && findPaymentBySessionId(event.providerSessionId)) ||
    (event.providerPaymentId && findPaymentByProviderPaymentId(event.providerPaymentId));

  if (!payment) {
    const message = `No payment found for this webhook event (session: ${event.providerSessionId || 'n/a'}, payment: ${event.providerPaymentId || 'n/a'}).`;
    // Log server-side regardless of what the caller does with the thrown
    // error — a webhook for a payment we don't recognize is worth knowing
    // about even if the HTTP response alone would tell Stripe/an operator
    // the same thing eventually.
    console.warn(`[payments] ${message}`);
    const err = new Error(message);
    err.code = 'PAYMENT_NOT_FOUND';
    throw err;
  }

  // Idempotency: a payment already in the status a webhook is trying to
  // set must not be re-processed by a duplicate event — the matching
  // timestamp (paidAt/cancelledAt/expiredAt/failedAt) must not change, the
  // linked entity must not be re-touched (for 'paid'), and no duplicate
  // email goes out. Covers all four terminal states, not just 'paid' —
  // a repeat `checkout.session.expired` re-setting expiredAt to a later
  // timestamp on every retry would itself be a (smaller, but real) way
  // for "the same webhook twice" to change data it shouldn't.
  const EVENT_TYPE_TO_STATUS = { 'payment.paid': 'paid', 'payment.cancelled': 'cancelled', 'payment.expired': 'expired', 'payment.failed': 'failed' };
  if (EVENT_TYPE_TO_STATUS[event.type] && payment.status === EVENT_TYPE_TO_STATUS[event.type]) {
    return {
      payment,
      entityResult: { applied: false, entityType: payment.entityType, entityId: payment.entityId, reason: `Payment was already ${payment.status} (idempotent no-op).` }
    };
  }

  const now = new Date().toISOString();
  const patch = { providerPaymentId: event.providerPaymentId || payment.providerPaymentId };

  if (event.type === 'payment.paid') {
    patch.status = 'paid';
    patch.paidAt = now;
  } else if (event.type === 'payment.cancelled') {
    patch.status = 'cancelled';
    patch.cancelledAt = now;
  } else if (event.type === 'payment.expired') {
    patch.status = 'expired';
    patch.expiredAt = now;
  } else if (event.type === 'payment.failed') {
    patch.status = 'failed';
    patch.failedAt = now;
    patch.errorMessage = event.errorMessage || 'Payment failed.';
  } else {
    const err = new Error(`Unknown webhook event type "${event.type}".`);
    err.code = 'UNKNOWN_EVENT_TYPE';
    throw err;
  }

  const updated = updatePaymentById(payment.id, patch);

  let entityResult = { applied: false, entityType: updated.entityType, entityId: updated.entityId, reason: 'Payment status is not paid.' };
  if (updated.status === 'paid') {
    entityResult = applyPaymentToEntity(updated);

    // Best-effort admin notification — never let an email failure affect
    // the webhook response (mirrors how leads/bookings/vin-checks already
    // send email after the record is safely saved).
    try {
      await sendPaymentPaidEmail(updated);
    } catch (err) {
      console.error('[email] sendPaymentPaidEmail failed unexpectedly:', err.message);
    }

    // Report auto-creation — deliberately wrapped defensively: a problem
    // here (DB error, unexpected shape, etc.) must never take down an
    // otherwise-successful webhook that already marked the payment paid.
    try {
      const report = createReportForPaidPayment(updated);
      if (report) {
        try {
          await sendReportCreatedEmail(report);
        } catch (err) {
          console.error('[email] sendReportCreatedEmail failed unexpectedly:', err.message);
        }
      }
    } catch (err) {
      console.error('[reports] createReportForPaidPayment failed unexpectedly:', err.message);
    }

    // Revenue-share accrual — same defensive pattern as the two blocks
    // above: a problem here must never take down an otherwise-successful
    // webhook, and the payment stays "paid" regardless (see
    // backend/README.md's "Revenue-share 20%" section — accrual is
    // pure bookkeeping, never anything the payment's own success should
    // depend on). accrueRevenueShareForPayment() has its own internal
    // idempotency check (see revenueShareService.js), on top of the
    // fact that this whole block already only runs once per payment's
    // genuine transition to "paid" (a repeat webhook returns early
    // above, before ever reaching here).
    try {
      accrueRevenueShareForPayment(updated);
    } catch (err) {
      console.error('[revenue-share] accrueRevenueShareForPayment failed unexpectedly:', err.message);
    }
  }

  return { payment: updated, entityResult };
}

/** Mock-provider-only convenience wrapper: parses the plain JSON test
 * payload and applies it. Throws WRONG_PROVIDER if PAYMENT_PROVIDER isn't
 * actually "mock" right now (prevents accidentally faking a paid status
 * while a real provider is selected). */
export async function handleMockWebhook(parsedBody) {
  const provider = getPaymentProvider();
  if (provider.getProviderName() !== 'mock') {
    const err = new Error('This looks like a mock webhook test payload, but PAYMENT_PROVIDER is not "mock" right now.');
    err.code = 'WRONG_PROVIDER';
    throw err;
  }

  const event = provider.parseWebhookEvent({ body: parsedBody });
  if (!event) {
    const err = new Error('Could not parse webhook payload — expected { type, providerSessionId }.');
    err.code = 'INVALID_WEBHOOK_PAYLOAD';
    throw err;
  }

  return applyWebhookEvent(event);
}

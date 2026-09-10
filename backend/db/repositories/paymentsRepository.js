import { db } from '../database.js';

const PAYMENT_COLUMNS = [
  'id', 'entityType', 'entityId', 'productCode', 'status', 'amount', 'currency',
  'provider', 'providerSessionId', 'providerPaymentId', 'checkoutUrl',
  'customerEmail', 'customerName', 'metadataJson', 'createdAt', 'updatedAt',
  'paidAt', 'cancelledAt', 'failedAt', 'errorMessage'
];

const insertStmt = db.prepare(`
  INSERT INTO payments (${PAYMENT_COLUMNS.join(', ')})
  VALUES (${PAYMENT_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM payments');
const selectByIdStmt = db.prepare('SELECT * FROM payments WHERE id = ?');
const selectBySessionIdStmt = db.prepare('SELECT * FROM payments WHERE providerSessionId = ?');
const selectByProviderPaymentIdStmt = db.prepare('SELECT * FROM payments WHERE providerPaymentId = ?');
const existsStmt = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE id = ?');
const updateStmt = db.prepare(`
  UPDATE payments
  SET status = @status, providerPaymentId = @providerPaymentId, paidAt = @paidAt,
      cancelledAt = @cancelledAt, failedAt = @failedAt, expiredAt = @expiredAt,
      errorMessage = @errorMessage, updatedAt = @updatedAt
  WHERE id = @id
`);
const updateMetadataStmt = db.prepare('UPDATE payments SET metadataJson = ?, updatedAt = ? WHERE id = ?');
const updateNoteStmt = db.prepare('UPDATE payments SET internalNote = ?, updatedAt = ? WHERE id = ?');
const updateAssignedAgentStmt = db.prepare('UPDATE payments SET assignedAgentId = ?, updatedAt = ? WHERE id = ?');

function toParams(payment) {
  const params = {};
  for (const col of PAYMENT_COLUMNS) {
    params[col] = payment[col] !== undefined ? payment[col] : null;
  }
  return params;
}

/** Inserts a payment (same shape POST /payments/checkout builds) and returns it as-is. */
export function insertPayment(payment) {
  insertStmt.run(toParams(payment));
  return payment;
}

/** Every payment, unfiltered/unsorted — the admin route does filter/sort/paginate in JS. */
export function findAllPayments() {
  return selectAllStmt.all();
}

/** Used by backend/ai/reportContext.js to attach a minimal payment
 * summary to an AI agent's context — filters findAllPayments() in JS,
 * same pattern as every other admin list route in this backend, so no
 * new prepared statement is needed for what's a rarely-called lookup. */
export function findPaymentsForEntity(entityType, entityId) {
  return findAllPayments().filter((p) => p.entityType === entityType && p.entityId === entityId);
}

export function findPaymentById(id) {
  return selectByIdStmt.get(id) || null;
}

export function findPaymentBySessionId(sessionId) {
  return selectBySessionIdStmt.get(sessionId) || null;
}

/** Used as a fallback when a webhook event (e.g. Stripe's
 * payment_intent.payment_failed) doesn't carry a checkout session id. */
export function findPaymentByProviderPaymentId(providerPaymentId) {
  return selectByProviderPaymentIdStmt.get(providerPaymentId) || null;
}

export function paymentExists(id) {
  return existsStmt.get(id).n > 0;
}

/**
 * Generic status-transition updater used by the webhook handler. `patch`
 * may include any of: status, providerPaymentId, paidAt, cancelledAt,
 * failedAt, errorMessage — anything omitted keeps its current value.
 * Returns the updated row, or null if no payment has that id.
 */
export function updatePaymentById(id, patch) {
  const existing = findPaymentById(id);
  if (!existing) return null;

  const merged = {
    id,
    status: patch.status !== undefined ? patch.status : existing.status,
    providerPaymentId: patch.providerPaymentId !== undefined ? patch.providerPaymentId : existing.providerPaymentId,
    paidAt: patch.paidAt !== undefined ? patch.paidAt : existing.paidAt,
    cancelledAt: patch.cancelledAt !== undefined ? patch.cancelledAt : existing.cancelledAt,
    failedAt: patch.failedAt !== undefined ? patch.failedAt : existing.failedAt,
    expiredAt: patch.expiredAt !== undefined ? patch.expiredAt : existing.expiredAt,
    errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
    updatedAt: new Date().toISOString()
  };

  updateStmt.run(merged);
  return findPaymentById(id);
}

/**
 * Records structured metadata on a payment — currently used only for
 * "payment succeeded but its linked booking/vin_check wasn't found"
 * warnings (see paymentService.js's recordLinkingWarning()). Kept
 * separate from updatePaymentById since it's a distinct, rarer concern
 * (an audit note, not a status transition).
 */
export function updatePaymentMetadata(id, metadataJson) {
  const updatedAt = new Date().toISOString();
  updateMetadataStmt.run(metadataJson, updatedAt, id);
  return findPaymentById(id);
}

/** Admin-only free-text note. Does not touch status, paidAt, or any other
 * payment-linking/idempotency field — purely a manual annotation. Returns
 * the updated row, or null if no payment has that id (route turns that
 * into a 404). */
export function updatePaymentNote(id, internalNote) {
  const existing = findPaymentById(id);
  if (!existing) return null;

  const updatedAt = new Date().toISOString();
  updateNoteStmt.run(internalNote, updatedAt, id);
  return findPaymentById(id);
}

/** assignedAgentId may be a real id or null (to unassign). Returns the
 * updated payment, or null if no payment has that id. Does not touch
 * status/paidAt/linking fields. */
export function updatePaymentAssignedAgent(id, assignedAgentId) {
  const existing = findPaymentById(id);
  if (!existing) return null;

  const updatedAt = new Date().toISOString();
  updateAssignedAgentStmt.run(assignedAgentId, updatedAt, id);
  return findPaymentById(id);
}

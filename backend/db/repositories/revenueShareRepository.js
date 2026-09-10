import crypto from 'crypto';
import { db } from '../database.js';

export const REVENUE_SHARE_LEDGER_STATUSES = ['accrued', 'excluded', 'included_in_payout', 'reversed'];
export const MONTHLY_PAYOUT_STATUSES = ['calculated', 'pending_manual_transfer', 'paid', 'cancelled', 'disputed'];

const SETTINGS_ID = 'revenue_share_settings_singleton';

// ---------------------------------------------------------------------------
// revenue_share_settings — a single row, always. Auto-created with safe
// defaults (enabled=0) on first read, so there's never a "no settings
// row exists yet" state for the rest of the app to handle.
// ---------------------------------------------------------------------------

const selectSettingsStmt = db.prepare('SELECT * FROM revenue_share_settings WHERE id = ?');
const insertSettingsStmt = db.prepare(`
  INSERT INTO revenue_share_settings (id, enabled, sharePercent, timezone, payoutDay, payoutTime, payoutMethod, payoutRecipientLabel, payoutRecipientMasked, notes, createdAt, updatedAt)
  VALUES (@id, @enabled, @sharePercent, @timezone, @payoutDay, @payoutTime, @payoutMethod, @payoutRecipientLabel, @payoutRecipientMasked, @notes, @createdAt, @updatedAt)
`);
const updateSettingsStmt = db.prepare(`
  UPDATE revenue_share_settings
  SET enabled = @enabled, sharePercent = @sharePercent, timezone = @timezone, payoutDay = @payoutDay,
      payoutTime = @payoutTime, payoutMethod = @payoutMethod, payoutRecipientLabel = @payoutRecipientLabel,
      payoutRecipientMasked = @payoutRecipientMasked, notes = @notes, updatedAt = @updatedAt
  WHERE id = @id
`);

function nestSettings(row) {
  if (!row) return null;
  return { ...row, enabled: !!row.enabled };
}

/** Returns the single settings row, creating it with safe defaults
 * (enabled=false) the first time anything asks for it. Never throws,
 * never returns null. */
export function getRevenueShareSettings() {
  const existing = selectSettingsStmt.get(SETTINGS_ID);
  if (existing) return nestSettings(existing);

  const now = new Date().toISOString();
  const defaults = {
    id: SETTINGS_ID,
    enabled: 0,
    sharePercent: 20,
    timezone: 'Europe/Prague',
    payoutDay: 1,
    payoutTime: '10:00',
    payoutMethod: null,
    payoutRecipientLabel: null,
    payoutRecipientMasked: null,
    notes: null,
    createdAt: now,
    updatedAt: now
  };
  insertSettingsStmt.run(defaults);
  return nestSettings(defaults);
}

/** Generic updater — anything omitted from `patch` keeps its current
 * value. Caller (see server.js) is responsible for validation
 * (sharePercent 0-100, payoutDay 1-28, payoutTime HH:mm, and rejecting
 * anything in payoutRecipientMasked that looks like a full card
 * number) — this function just persists whatever it's given. */
export function updateRevenueShareSettings(patch) {
  const existing = getRevenueShareSettings();
  const merged = {
    id: SETTINGS_ID,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
    sharePercent: patch.sharePercent !== undefined ? patch.sharePercent : existing.sharePercent,
    timezone: patch.timezone !== undefined ? patch.timezone : existing.timezone,
    payoutDay: patch.payoutDay !== undefined ? patch.payoutDay : existing.payoutDay,
    payoutTime: patch.payoutTime !== undefined ? patch.payoutTime : existing.payoutTime,
    payoutMethod: patch.payoutMethod !== undefined ? patch.payoutMethod : existing.payoutMethod,
    payoutRecipientLabel: patch.payoutRecipientLabel !== undefined ? patch.payoutRecipientLabel : existing.payoutRecipientLabel,
    payoutRecipientMasked: patch.payoutRecipientMasked !== undefined ? patch.payoutRecipientMasked : existing.payoutRecipientMasked,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    updatedAt: new Date().toISOString()
  };
  updateSettingsStmt.run(merged);
  return getRevenueShareSettings();
}

// ---------------------------------------------------------------------------
// revenue_share_ledger — one row per paid payment that revenue-share
// logic has ever looked at (both eligible/"accrued" and ineligible/
// "excluded" payments get a row, for a complete audit trail — see
// backend/revenueShare/revenueShareService.js for exactly when each
// happens). Never updated in place except status transitions
// (accrued -> included_in_payout, or -> reversed) — the financial
// fields (paymentAmount/shareAmount/etc.) are immutable once written.
// ---------------------------------------------------------------------------

const LEDGER_COLUMNS = ['id', 'paymentId', 'paymentAmount', 'currency', 'sharePercent', 'shareAmount', 'paymentPaidAt', 'monthKey', 'status', 'createdAt'];

const insertLedgerStmt = db.prepare(`
  INSERT INTO revenue_share_ledger (${LEDGER_COLUMNS.join(', ')})
  VALUES (${LEDGER_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectLedgerByPaymentIdStmt = db.prepare('SELECT * FROM revenue_share_ledger WHERE paymentId = ?');
const selectAllLedgerStmt = db.prepare('SELECT * FROM revenue_share_ledger');
const selectLedgerByIdStmt = db.prepare('SELECT * FROM revenue_share_ledger WHERE id = ?');
const updateLedgerStatusStmt = db.prepare('UPDATE revenue_share_ledger SET status = ? WHERE id = ?');

function generateLedgerId() {
  return 'rsledger_' + crypto.randomBytes(6).toString('hex');
}

/** True if this payment already has a ledger row — the idempotency
 * check accrueRevenueShareForPayment() must run before ever inserting,
 * so a duplicate webhook (or any other repeat call) can never create a
 * second row for the same payment. */
export function ledgerEntryExistsForPayment(paymentId) {
  return !!selectLedgerByPaymentIdStmt.get(paymentId);
}

export function insertLedgerEntry(data) {
  const entry = {
    id: generateLedgerId(),
    paymentId: data.paymentId,
    paymentAmount: data.paymentAmount,
    currency: data.currency,
    sharePercent: data.sharePercent,
    shareAmount: data.shareAmount,
    paymentPaidAt: data.paymentPaidAt,
    monthKey: data.monthKey,
    status: data.status,
    createdAt: new Date().toISOString()
  };
  insertLedgerStmt.run(entry);
  return entry;
}

export function getLedgerEntryById(id) {
  return selectLedgerByIdStmt.get(id) || null;
}

/** Used when a monthly payout is created — moves every 'accrued' row
 * for that monthKey+currency into 'included_in_payout' in one pass.
 * Deliberately takes an explicit list of ids (computed by the caller
 * from the same query that computed the payout total) rather than
 * re-querying here, so the set of rows moved is guaranteed to be
 * exactly the set that was totalled. */
export function markLedgerEntriesIncludedInPayout(ids) {
  const update = db.transaction((entryIds) => {
    for (const id of entryIds) {
      updateLedgerStatusStmt.run('included_in_payout', id);
    }
  });
  update(ids);
}

function filterLedgerRows(filters) {
  let rows = selectAllLedgerStmt.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filters.status) rows = rows.filter((r) => r.status === filters.status);
  if (filters.monthKey) rows = rows.filter((r) => r.monthKey === filters.monthKey);
  if (filters.paymentId) rows = rows.filter((r) => r.paymentId === filters.paymentId);
  if (filters.search) {
    const q = String(filters.search).trim().toLowerCase();
    rows = rows.filter((r) => (r.id || '').toLowerCase().includes(q) || (r.paymentId || '').toLowerCase().includes(q));
  }

  return rows;
}

export function listRevenueShareLedger(filters = {}) {
  const rows = filterLedgerRows(filters);
  const total = rows.length;
  const offset = Math.max(0, parseInt(filters.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit, 10) || 50));
  return { items: rows.slice(offset, offset + limit), total };
}

export function listAllMatchingLedger(filters = {}) {
  return filterLedgerRows(filters);
}

/** Every 'accrued' ledger row for one monthKey — the exact input to a
 * payout calculation. Returns rows across all currencies present;
 * callers group by currency themselves (see revenueShareService.js). */
export function listAccruedLedgerForMonth(monthKey) {
  return selectAllLedgerStmt.all().filter((r) => r.monthKey === monthKey && r.status === 'accrued');
}

// ---------------------------------------------------------------------------
// monthly_payouts
// ---------------------------------------------------------------------------

const PAYOUT_COLUMNS = ['id', 'monthKey', 'currency', 'grossRevenue', 'sharePercent', 'shareAmount', 'status', 'payoutDueAt', 'payoutMethod', 'payoutRecipientMasked', 'createdAt', 'updatedAt'];

const insertPayoutStmt = db.prepare(`
  INSERT INTO monthly_payouts (${PAYOUT_COLUMNS.join(', ')})
  VALUES (${PAYOUT_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllPayoutsStmt = db.prepare('SELECT * FROM monthly_payouts');
const selectPayoutByIdStmt = db.prepare('SELECT * FROM monthly_payouts WHERE id = ?');
const updatePayoutStmt = db.prepare(`
  UPDATE monthly_payouts
  SET status = @status, markedPaidAt = @markedPaidAt, internalNote = @internalNote, updatedAt = @updatedAt
  WHERE id = @id
`);

function generatePayoutId() {
  return 'payout_' + crypto.randomBytes(6).toString('hex');
}

/** True if a non-cancelled payout already exists for this monthKey+
 * currency — the idempotency check createMonthlyPayout() must run
 * before ever inserting a second one. A cancelled payout doesn't block
 * a fresh calculation (e.g. if the first one was cancelled for being
 * wrong). */
export function findActivePayoutForMonth(monthKey, currency) {
  return selectAllPayoutsStmt.all().find((p) => p.monthKey === monthKey && p.currency === currency && p.status !== 'cancelled') || null;
}

/** Same idea as findActivePayoutForMonth() but without a currency
 * filter — used to detect "this month was already calculated" BEFORE
 * even trying a fresh calculation. Needed because once a payout is
 * created, its ledger rows move out of 'accrued' (see
 * markLedgerEntriesIncludedInPayout()), so a naive
 * "is there anything to calculate" check on a second attempt would
 * find nothing and report the less useful NOTHING_TO_CALCULATE instead
 * of the more specific ALREADY_EXISTS. */
export function findAnyActivePayoutForMonth(monthKey) {
  return selectAllPayoutsStmt.all().find((p) => p.monthKey === monthKey && p.status !== 'cancelled') || null;
}

export function insertMonthlyPayout(data) {
  const now = new Date().toISOString();
  const payout = {
    id: generatePayoutId(),
    monthKey: data.monthKey,
    currency: data.currency,
    grossRevenue: data.grossRevenue,
    sharePercent: data.sharePercent,
    shareAmount: data.shareAmount,
    status: data.status,
    payoutDueAt: data.payoutDueAt,
    payoutMethod: data.payoutMethod ?? null,
    payoutRecipientMasked: data.payoutRecipientMasked ?? null,
    createdAt: now,
    updatedAt: now
  };
  insertPayoutStmt.run(payout);
  return getPayoutById(payout.id);
}

export function getPayoutById(id) {
  const row = selectPayoutByIdStmt.get(id);
  return row || null;
}

function filterPayoutRows(filters) {
  let rows = selectAllPayoutsStmt.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filters.status) rows = rows.filter((r) => r.status === filters.status);
  if (filters.monthKey) rows = rows.filter((r) => r.monthKey === filters.monthKey);

  return rows;
}

export function listMonthlyPayouts(filters = {}) {
  const rows = filterPayoutRows(filters);
  const total = rows.length;
  const offset = Math.max(0, parseInt(filters.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit, 10) || 50));
  return { items: rows.slice(offset, offset + limit), total };
}

export function listAllMatchingPayouts(filters = {}) {
  return filterPayoutRows(filters);
}

/**
 * Transitions status/internalNote — anything omitted from `patch` keeps
 * its current value. Sets `markedPaidAt` the first time status becomes
 * 'paid' (never overwritten after that). This is the ONLY function that
 * can move a payout to 'paid' — there is no automatic transfer anywhere
 * in this codebase; a human admin always calls this explicitly (see
 * PATCH /admin/revenue-share/payouts/:id/mark-paid in server.js).
 */
export function updateMonthlyPayout(id, patch) {
  const existing = getPayoutById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const merged = {
    id,
    status: patch.status !== undefined ? patch.status : existing.status,
    internalNote: patch.internalNote !== undefined ? patch.internalNote : existing.internalNote,
    markedPaidAt: existing.markedPaidAt
  };
  if (merged.status === 'paid' && !merged.markedPaidAt) {
    merged.markedPaidAt = now;
  }
  merged.updatedAt = now;

  updatePayoutStmt.run(merged);
  return getPayoutById(id);
}

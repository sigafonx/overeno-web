import {
  getRevenueShareSettings, ledgerEntryExistsForPayment, insertLedgerEntry,
  listRevenueShareLedger, listAllMatchingLedger, listAccruedLedgerForMonth,
  markLedgerEntriesIncludedInPayout, findActivePayoutForMonth, findAnyActivePayoutForMonth, insertMonthlyPayout,
  listMonthlyPayouts, listAllMatchingPayouts, updateMonthlyPayout, getPayoutById
} from '../db/repositories/revenueShareRepository.js';

// ---------------------------------------------------------------------------
// This file NEVER moves money. Every function here either reads data or
// writes a bookkeeping row (ledger entry / payout record). The one
// function that marks a payout "paid" (markPayoutPaid) only flips a
// status flag after a human admin has done a transfer themselves,
// outside this system — see backend/README.md's "Revenue-share 20%"
// section for the full picture, including why a real Wise API
// integration is deliberately NOT part of this step.
// ---------------------------------------------------------------------------

// Only these product codes ever accrue revenue-share — matches exactly
// what the business rule (see README) defines as eligible. A paid
// payment for any other productCode still gets a ledger row (for a
// complete audit trail of every paid payment revenue-share ever looked
// at), just with status="excluded" and shareAmount=0.
export const REVENUE_SHARE_ELIGIBLE_PRODUCTS = ['vin_basic_report', 'inspection_booking_deposit', 'manual_car_review'];

function computeMonthKey(isoDateString, timezone) {
  const date = new Date(isoDateString);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' });
  const parts = formatter.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}`;
}

/**
 * Timezone-aware construction of "day `payoutDay` of the month AFTER
 * `monthKey`, at `payoutTime`, in `timezone`" as a UTC ISO string —
 * i.e. exactly the business rule "1st of each month at 10:00 local
 * time" from the README, generalized to whatever settings say. Uses
 * the standard double-conversion trick (guess a UTC instant, see what
 * wall-clock time that is in the target timezone, correct by the
 * difference) so DST transitions in `timezone` are handled correctly
 * for the specific date in question, not a fixed offset.
 */
function computePayoutDueAtUtc(monthKey, payoutDay, payoutTime, timezone) {
  const [year, month] = monthKey.split('-').map(Number);
  let dueYear = year;
  let dueMonth = month + 1;
  if (dueMonth > 12) {
    dueMonth = 1;
    dueYear += 1;
  }
  const dueDay = Math.min(Math.max(1, payoutDay), 28);
  const [hh, mm] = (payoutTime || '10:00').split(':').map(Number);

  const guessUtc = new Date(Date.UTC(dueYear, dueMonth - 1, dueDay, hh || 0, mm || 0, 0));
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = tzFormatter.formatToParts(guessUtc).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour24 = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour24, Number(parts.minute), Number(parts.second));
  const offsetMs = asIfUtc - guessUtc.getTime();
  return new Date(guessUtc.getTime() - offsetMs).toISOString();
}

/**
 * Called once, from paymentService.js's applyWebhookEvent(), right
 * after a payment's status genuinely transitions to "paid" (never on a
 * repeat/idempotent webhook — that path already returns early before
 * this would ever be called again). Still checks
 * ledgerEntryExistsForPayment() itself as a second, independent
 * safety net — belt-and-braces idempotency, matching the pattern used
 * throughout this codebase (see backend/README.md's payment webhook
 * idempotency notes).
 *
 * Creates exactly one revenue_share_ledger row per paid payment, ever:
 *   - skipped entirely (no row) if revenue-share is disabled in
 *     settings, or if a row for this payment already exists;
 *   - status="accrued" if the payment's productCode is eligible;
 *   - status="excluded" (shareAmount=0) if it isn't — kept for a
 *     complete audit trail of every paid payment, not just the ones
 *     that counted.
 * Never throws in a way that should reach the caller uncaught — see
 * paymentService.js's own try/catch around this call, matching how
 * email sending / report auto-creation are already handled there.
 */
export function accrueRevenueShareForPayment(payment) {
  if (!payment || payment.status !== 'paid') return null;

  const settings = getRevenueShareSettings();
  if (!settings.enabled) return null;

  if (ledgerEntryExistsForPayment(payment.id)) return null;

  const isEligible = REVENUE_SHARE_ELIGIBLE_PRODUCTS.includes(payment.productCode);
  const paidAt = payment.paidAt || new Date().toISOString();
  const monthKey = computeMonthKey(paidAt, settings.timezone);
  const sharePercent = settings.sharePercent;
  const shareAmount = isEligible ? Math.round((payment.amount * sharePercent) / 100) : 0;

  return insertLedgerEntry({
    paymentId: payment.id,
    paymentAmount: payment.amount,
    currency: payment.currency,
    sharePercent,
    shareAmount,
    paymentPaidAt: paidAt,
    monthKey,
    status: isEligible ? 'accrued' : 'excluded'
  });
}

/**
 * Pure calculation, no writes — groups every 'accrued' ledger row for
 * `monthKey` by currency (almost always just one currency in practice,
 * but never assumed) and returns one preview object per currency:
 * { monthKey, currency, grossRevenue, sharePercent, shareAmount, ledgerIds }.
 * `sharePercent` here is read fresh from current settings (not from the
 * ledger rows, which each freeze the rate at the time they were
 * accrued) so a preview always reflects "if I paid out today" — the
 * actual accrued shareAmount per row is still what gets summed for the
 * total, so a mid-month rate change never silently reprices
 * already-accrued entries.
 */
export function calculateMonthlyPayout(monthKey) {
  const settings = getRevenueShareSettings();
  const rows = listAccruedLedgerForMonth(monthKey);
  if (rows.length === 0) return [];

  const byCurrency = new Map();
  for (const row of rows) {
    if (!byCurrency.has(row.currency)) {
      byCurrency.set(row.currency, { monthKey, currency: row.currency, grossRevenue: 0, shareAmount: 0, ledgerIds: [] });
    }
    const bucket = byCurrency.get(row.currency);
    bucket.grossRevenue += row.paymentAmount;
    bucket.shareAmount += row.shareAmount;
    bucket.ledgerIds.push(row.id);
  }

  return Array.from(byCurrency.values()).map((bucket) => ({ ...bucket, sharePercent: settings.sharePercent }));
}

/**
 * Actually persists what calculateMonthlyPayout() computed: one
 * monthly_payouts row per currency, status="pending_manual_transfer"
 * immediately (this step never uses "calculated" as a stored
 * intermediate — see the status enum's own comment in
 * revenueShareRepository.js), and moves the corresponding ledger rows
 * to "included_in_payout" in the same pass. Idempotent per
 * monthKey+currency — calling this again for a month that already has
 * a non-cancelled payout throws ALREADY_EXISTS instead of creating a
 * duplicate. Throws NOTHING_TO_CALCULATE if there's no accrued revenue
 * for the month at all.
 */
export function createMonthlyPayout(monthKey) {
  // Checked FIRST, before calculateMonthlyPayout() — once a payout for
  // this month exists, its ledger rows have already moved out of
  // 'accrued' (see markLedgerEntriesIncludedInPayout()), so a second
  // attempt would otherwise see "nothing accrued" and report the less
  // useful NOTHING_TO_CALCULATE instead of the more specific, more
  // correct ALREADY_EXISTS.
  const existingAny = findAnyActivePayoutForMonth(monthKey);
  if (existingAny) {
    const err = new Error(`A payout for ${monthKey} already exists (${existingAny.id}, status: ${existingAny.status}).`);
    err.code = 'ALREADY_EXISTS';
    err.payoutId = existingAny.id;
    throw err;
  }

  const previews = calculateMonthlyPayout(monthKey);
  if (previews.length === 0) {
    const err = new Error(`No accrued revenue-share entries found for month "${monthKey}" — nothing to calculate.`);
    err.code = 'NOTHING_TO_CALCULATE';
    throw err;
  }

  const settings = getRevenueShareSettings();
  const payoutDueAt = computePayoutDueAtUtc(monthKey, settings.payoutDay, settings.payoutTime, settings.timezone);

  const created = [];
  for (const preview of previews) {
    const existing = findActivePayoutForMonth(monthKey, preview.currency);
    if (existing) {
      const err = new Error(`A payout for ${monthKey} (${preview.currency}) already exists (${existing.id}, status: ${existing.status}).`);
      err.code = 'ALREADY_EXISTS';
      err.payoutId = existing.id;
      throw err;
    }

    const payout = insertMonthlyPayout({
      monthKey: preview.monthKey,
      currency: preview.currency,
      grossRevenue: preview.grossRevenue,
      sharePercent: preview.sharePercent,
      shareAmount: preview.shareAmount,
      status: 'pending_manual_transfer',
      payoutDueAt,
      payoutMethod: settings.payoutMethod,
      payoutRecipientMasked: settings.payoutRecipientMasked
    });

    markLedgerEntriesIncludedInPayout(preview.ledgerIds);
    created.push(payout);
  }

  return created;
}

/**
 * The ONLY function in this codebase that can set a payout's status to
 * "paid" — always called from an explicit admin action
 * (PATCH /admin/revenue-share/payouts/:id/mark-paid), always meaning
 * "an admin manually sent this via Wise (or however) and is recording
 * that fact" — never triggers or performs any transfer itself. Refuses
 * to mark an already-paid or cancelled payout paid again. Returns the
 * updated payout, or null if no payout has that id.
 */
export function markPayoutPaid(payoutId) {
  const existing = getPayoutById(payoutId);
  if (!existing) return null;
  if (existing.status === 'paid') {
    const err = new Error('This payout is already marked paid.');
    err.code = 'ALREADY_PAID';
    throw err;
  }
  if (existing.status === 'cancelled') {
    const err = new Error('This payout is cancelled — cannot mark a cancelled payout as paid.');
    err.code = 'CANCELLED';
    throw err;
  }
  return updateMonthlyPayout(payoutId, { status: 'paid' });
}

export function listLedger(filters) {
  return listRevenueShareLedger(filters);
}

export function listAllMatchingLedgerEntries(filters) {
  return listAllMatchingLedger(filters);
}

export function listPayouts(filters) {
  return listMonthlyPayouts(filters);
}

export function listAllMatchingPayoutRecords(filters) {
  return listAllMatchingPayouts(filters);
}

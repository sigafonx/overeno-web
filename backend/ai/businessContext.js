import { findLeadById, findAllLeads } from '../db/repositories/leadsRepository.js';
import { findBookingById, findAllBookings } from '../db/repositories/bookingsRepository.js';
import { findVinCheckById, findAllVinChecks } from '../db/repositories/vinChecksRepository.js';
import { findPaymentById, findAllPayments } from '../db/repositories/paymentsRepository.js';
import { findEmailLogById, findAllEmailLogs } from '../db/repositories/emailLogsRepository.js';
import { getRevenueShareSettings } from '../db/repositories/revenueShareRepository.js';
import { calculateMonthlyPayout, listAllMatchingLedgerEntries, listAllMatchingPayoutRecords } from '../revenueShare/revenueShareService.js';

// How far back "recent" looks for the dashboard/admin-operations aggregate
// below — deliberately a fixed constant, not configurable, since this is
// a lightweight cross-entity summary, not a reporting tool.
const DASHBOARD_WINDOW_DAYS = 7;

function isWithinWindowDays(iso, days) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= days * 86400000;
}

const BOOKING_STATUSES_NEEDING_ACTION = ['new', 'contacted', 'waiting_payment', 'inspector_needed'];

/**
 * Aggregate-only cross-entity counts for the Admin Operations / Business
 * Growth agents — deliberately NEVER includes an individual record's
 * PII (name/email/phone/message) or even an id list, only counts over a
 * fixed recent window. This is what makes it safe to hand to an AI
 * provider (mock or real) without a privacy review beyond what already
 * applies to aggregate statistics.
 */
function buildDashboardContext() {
  const leads = findAllLeads();
  const bookings = findAllBookings();
  const payments = findAllPayments();
  const emailLogs = findAllEmailLogs();
  const vinChecks = findAllVinChecks();

  return {
    dashboard: {
      windowDays: DASHBOARD_WINDOW_DAYS,
      newLeadsCount: leads.filter((l) => isWithinWindowDays(l.createdAt, DASHBOARD_WINDOW_DAYS)).length,
      bookingsNeedingActionCount: bookings.filter((b) => BOOKING_STATUSES_NEEDING_ACTION.includes(b.status)).length,
      failedPaymentsCount: payments.filter((p) => p.status === 'failed' && isWithinWindowDays(p.createdAt, DASHBOARD_WINDOW_DAYS)).length,
      cancelledPaymentsCount: payments.filter((p) => p.status === 'cancelled' && isWithinWindowDays(p.createdAt, DASHBOARD_WINDOW_DAYS)).length,
      failedEmailsCount: emailLogs.filter((e) => e.status === 'failed' && isWithinWindowDays(e.createdAt, DASHBOARD_WINDOW_DAYS)).length,
      pendingVinChecksCount: vinChecks.filter((v) => v.paymentStatus !== 'paid' && isWithinWindowDays(v.createdAt, DASHBOARD_WINDOW_DAYS)).length,
      totalLeads: leads.length,
      totalBookings: bookings.length,
      totalPayments: payments.length
    }
  };
}

/**
 * Read-only revenue-share summary for one calendar month (see
 * backend/revenueShare/revenueShareService.js — this never calculates a
 * NEW payout row, it only reads what's already there, or previews the
 * live ledger total if no payout has been created for that month yet).
 * Prefers an existing monthly_payouts row (already-persisted numbers +
 * real payoutDueAt/status) over the live preview, since that's the more
 * authoritative source once one exists.
 */
function buildRevenueShareSummary(monthKey) {
  const settings = getRevenueShareSettings();
  const ledgerEntries = listAllMatchingLedgerEntries({ monthKey });
  const existingPayouts = listAllMatchingPayoutRecords({ monthKey });

  if (existingPayouts.length > 0) {
    const payout = existingPayouts[0];
    return {
      monthKey,
      enabled: settings.enabled,
      sharePercent: payout.sharePercent,
      currency: payout.currency,
      grossRevenue: payout.grossRevenue,
      shareAmount: payout.shareAmount,
      ledgerEntryCount: ledgerEntries.length,
      payoutDueAt: payout.payoutDueAt,
      payoutStatus: payout.status
    };
  }

  const previews = calculateMonthlyPayout(monthKey);
  const preview = previews[0] || null;
  return {
    monthKey,
    enabled: settings.enabled,
    sharePercent: settings.sharePercent,
    currency: preview ? preview.currency : null,
    grossRevenue: preview ? preview.grossRevenue : 0,
    shareAmount: preview ? preview.shareAmount : 0,
    ledgerEntryCount: ledgerEntries.length,
    payoutDueAt: null,
    payoutStatus: 'not_calculated_yet'
  };
}

/**
 * Builds the context object passed as `input` to a wave-2 business
 * agent run when the admin just clicks one of the "Generate follow-up"/
 * "Suggest next step"/"Analyze payment issue" buttons without typing
 * anything manually (see businessAgentRunner.js — this is only used
 * when the caller omits `input`).
 *
 * Deliberately excludes, on every entity type:
 *   - internalNote (admin-private, never shown to an AI drafting
 *     customer-facing text)
 *   - email, phone (contact details aren't needed to DRAFT message
 *     text — the admin already has these on the entity itself to
 *     actually send anything; the AI only needs enough to personalize
 *     a draft, not the means to contact anyone itself)
 *   - any provider/payment-processor internal id (session ids, etc.)
 *
 * `contactName` IS included (unlike backend/ai/reportContext.js's
 * booking context) — these agents are specifically drafting a message
 * addressed to a person, so a first name for personalization is
 * legitimately useful, in a way it isn't for report-writing agents.
 *
 * Returns null if the entity doesn't exist, or entityType isn't one
 * this function knows how to gather (callers treat both as a
 * validation error).
 */
export function buildBusinessContext(entityType, entityId) {
  if (entityType === 'lead') {
    const lead = findLeadById(entityId);
    if (!lead) return null;
    return {
      lead: {
        type: lead.type,
        status: lead.status,
        companyName: lead.companyName || null,
        contactName: lead.contactName || null,
        city: lead.city || null,
        vehiclesCount: lead.vehiclesCount || null,
        qualification: lead.qualification || null,
        availability: lead.availability || null,
        message: lead.message || null,
        createdAt: lead.createdAt
      }
    };
  }

  if (entityType === 'booking') {
    const booking = findBookingById(entityId);
    if (!booking) return null;
    return {
      booking: {
        status: booking.status,
        contactName: booking.contactName || null,
        city: booking.city,
        preferredSlot: booking.preferredSlot,
        listingUrl: booking.listingUrl || null,
        message: booking.message || null,
        createdAt: booking.createdAt
      }
    };
  }

  if (entityType === 'vin_check') {
    const vinCheck = findVinCheckById(entityId);
    if (!vinCheck || !vinCheck.result) return null;
    return {
      vinCheck: {
        vin: vinCheck.vin,
        status: vinCheck.status,
        riskLevel: vinCheck.result.riskLevel,
        score: vinCheck.result.score,
        isDemoResult: !!vinCheck.result.isDemoResult,
        paymentStatus: vinCheck.paymentStatus || null,
        createdAt: vinCheck.createdAt
      }
    };
  }

  if (entityType === 'payment') {
    const payment = findPaymentById(entityId);
    if (!payment) return null;
    return {
      payment: {
        status: payment.status,
        productCode: payment.productCode,
        amount: payment.amount,
        currency: payment.currency,
        provider: payment.provider,
        errorMessage: payment.errorMessage || null,
        createdAt: payment.createdAt
      }
    };
  }

  // Email Support Agent extension — entityId is an email_logs row id.
  // recipientEmail is deliberately excluded, same PII-minimization
  // principle as every other branch above (the admin already has the
  // real address on the entity itself if they decide to actually send
  // something).
  if (entityType === 'email_log') {
    const emailLog = findEmailLogById(entityId);
    if (!emailLog) return null;
    return {
      emailLog: {
        entityType: emailLog.entityType,
        entityId: emailLog.entityId,
        recipientType: emailLog.recipientType,
        subject: emailLog.subject || null,
        status: emailLog.status,
        errorMessage: emailLog.errorMessage || null,
        createdAt: emailLog.createdAt,
        reviewedAt: emailLog.reviewedAt || null,
        resolvedAt: emailLog.resolvedAt || null
      }
    };
  }

  // Admin Operations Agent / Business Growth Agent — no single entity to
  // fetch; entityId is just a free-form label (e.g. "today") the admin
  // picks when running the agent. Always succeeds (never "not found")
  // since this is a live aggregate, not a lookup.
  if (entityType === 'dashboard') {
    return buildDashboardContext();
  }

  // Revenue Share Agent — entityId is a "YYYY-MM" monthKey. Returns null
  // (treated as a validation error by the caller) for anything that
  // doesn't look like a real month key, rather than silently defaulting
  // to some other month.
  if (entityType === 'revenue_share') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(entityId))) return null;
    return { revenueShare: buildRevenueShareSummary(entityId) };
  }

  return null;
}

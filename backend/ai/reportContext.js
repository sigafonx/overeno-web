import { getReportById } from '../db/repositories/reportsRepository.js';
import { listSections } from '../db/repositories/reportSectionsRepository.js';
import { findVinCheckById } from '../db/repositories/vinChecksRepository.js';
import { findBookingById } from '../db/repositories/bookingsRepository.js';
import { findPaymentsForEntity } from '../db/repositories/paymentsRepository.js';

/**
 * Builds the context object passed as `input` to an agent run when the
 * admin just clicks "Run" against a report without typing any input
 * manually (see orchestrator.js's runAgent() — this is only used when
 * the caller omits `input` for a report-linked run).
 *
 * Deliberately excludes, on every entity it touches:
 *   - reports.internalNote
 *   - vin_checks.internalNote
 *   - bookings.internalNote, .email, .phone, .contactName (PII)
 *   - any payment field beyond productCode/amount/currency/status
 *     (never customerEmail, never provider session/payment ids)
 * This is an explicit allowlist, not "the row minus a few fields" — the
 * same principle GET /reports/public/:token already follows for the
 * public report page (see backend/README.md's "Secure report delivery"
 * section for that precedent).
 *
 * Returns null if the report doesn't exist — callers treat that as a
 * validation error (report must exist before an agent can run against it).
 */
export function buildReportContext(reportId) {
  const report = getReportById(reportId);
  if (!report) return null;

  const sections = listSections(reportId).map((s) => ({
    sectionKey: s.sectionKey,
    title: s.title,
    content: s.content || ''
  }));

  const context = {
    report: {
      reportType: report.reportType,
      status: report.status,
      title: report.title,
      summary: report.summary,
      verdict: report.verdict,
      riskLevel: report.riskLevel,
      score: report.score,
      language: report.language
    },
    sections
  };

  if (report.entityType === 'vin_check') {
    const vinCheck = findVinCheckById(report.entityId);
    // findVinCheckById() nests the actual VIN-check result fields under
    // .result (see vinChecksRepository.js's nestRow()) — NOT flat on the
    // returned object. Reading vinCheck.year etc. directly here would
    // silently pull undefined for every field.
    if (vinCheck && vinCheck.result) {
      context.vinCheck = {
        vin: vinCheck.vin,
        year: vinCheck.result.year,
        estimatedMileage: vinCheck.result.estimatedMileage,
        advertisedMileage: vinCheck.result.advertisedMileage,
        accidents: vinCheck.result.accidents,
        owners: vinCheck.result.owners,
        odometerRisk: vinCheck.result.odometerRisk,
        verdictKey: vinCheck.result.verdictKey,
        riskLevel: vinCheck.result.riskLevel,
        score: vinCheck.result.score,
        // Critical: this is demo data, not a real vehicle-history lookup
        // (see backend/README.md's VIN-check section) — passed through
        // explicitly so every agent's prompt can (and does — see
        // prompts/reportPrompts.js) tell the model not to treat it as an
        // official/verified result.
        isDemoResult: !!vinCheck.result.isDemoResult
      };
    }
  } else if (report.entityType === 'booking') {
    const booking = findBookingById(report.entityId);
    if (booking) {
      context.booking = {
        vin: booking.vin || null,
        listingUrl: booking.listingUrl || null,
        city: booking.city,
        message: booking.message || null
      };
    }
  }
  // entityType === 'manual_review': no separate linked entity to fetch —
  // the report's own fields + sections are the full context already.

  const payments = findPaymentsForEntity(report.entityType, report.entityId);
  if (payments.length > 0) {
    context.payment = payments.map((p) => ({
      productCode: p.productCode,
      amount: p.amount,
      currency: p.currency,
      status: p.status
    }));
  }

  return context;
}

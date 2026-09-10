import { findLeadById } from '../db/repositories/leadsRepository.js';
import { findBookingById } from '../db/repositories/bookingsRepository.js';
import { findVinCheckById } from '../db/repositories/vinChecksRepository.js';
import { findPaymentById } from '../db/repositories/paymentsRepository.js';

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

  return null;
}

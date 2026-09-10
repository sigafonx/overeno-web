import crypto from 'crypto';
import { sendEmail } from './emailClient.js';
import * as templates from './templates.js';
import { insertEmailLog } from '../db/repositories/emailLogsRepository.js';

const EMAIL_LOGGING_ENABLED = String(process.env.EMAIL_LOGGING_ENABLED ?? 'true').toLowerCase() !== 'false';

function generateEmailLogId() {
  return 'emaillog_' + crypto.randomBytes(6).toString('hex');
}

function getAdminRecipient() {
  const value = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || '';
  return value.trim();
}

/**
 * Logs one send attempt to email_logs (id/status/entityType/etc — see
 * schema). Chosen behavior: every attempt is logged, including 'skipped'
 * ones (no recipient, or EMAIL_ENABLED=false) — this stays useful for
 * debugging "did the system even try" regardless of whether email is
 * turned on. Set EMAIL_LOGGING_ENABLED=false to turn logging off entirely.
 */
function logAttempt({ entityType, entityId, recipientType, recipientEmail, subject, status, errorMessage }) {
  if (!EMAIL_LOGGING_ENABLED) return;
  try {
    insertEmailLog({
      id: generateEmailLogId(),
      entityType,
      entityId,
      recipientType,
      recipientEmail: recipientEmail || null,
      subject: subject || null,
      status,
      errorMessage: errorMessage || null,
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    // Logging must never be able to break the request that triggered it.
    console.error('[email] Failed to write email_logs row:', err.message);
  }
}

async function sendAndLog({ entityType, entityId, recipientType, to, subject, html, text }) {
  const result = await sendEmail({ to, subject, html, text });

  if (result.ok) {
    logAttempt({ entityType, entityId, recipientType, recipientEmail: to, subject, status: 'sent' });
    return { sent: true };
  }
  if (result.skipped) {
    logAttempt({ entityType, entityId, recipientType, recipientEmail: to, subject, status: 'skipped', errorMessage: result.reason });
    return { sent: false };
  }
  logAttempt({ entityType, entityId, recipientType, recipientEmail: to, subject, status: 'failed', errorMessage: result.error });
  return { sent: false, error: result.error };
}

/**
 * All three sendXEmails() functions share this shape:
 *   - always attempt the admin email (skipped/logged if no admin address set);
 *   - attempt the user email only if the record has an email address;
 *   - never throw — errors are collected and returned, not raised, so a
 *     broken SMTP config can never affect the HTTP response that triggered it.
 * Return shape: { adminEmailSent, userEmailSent, errors: string[] }
 */
export async function sendLeadEmails(lead) {
  const errors = [];

  const admin = templates.adminNewLeadEmail(lead);
  const adminResult = await sendAndLog({
    entityType: 'lead', entityId: lead.id, recipientType: 'admin',
    to: getAdminRecipient(), subject: admin.subject, html: admin.html, text: admin.text
  });
  if (adminResult.error) errors.push(adminResult.error);

  let userResult = { sent: false };
  if (lead.email) {
    const user = templates.userLeadConfirmationEmail(lead);
    userResult = await sendAndLog({
      entityType: 'lead', entityId: lead.id, recipientType: 'user',
      to: lead.email, subject: user.subject, html: user.html, text: user.text
    });
    if (userResult.error) errors.push(userResult.error);
  }

  return { adminEmailSent: adminResult.sent, userEmailSent: userResult.sent, errors };
}

export async function sendBookingEmails(booking) {
  const errors = [];

  const admin = templates.adminNewBookingEmail(booking);
  const adminResult = await sendAndLog({
    entityType: 'booking', entityId: booking.id, recipientType: 'admin',
    to: getAdminRecipient(), subject: admin.subject, html: admin.html, text: admin.text
  });
  if (adminResult.error) errors.push(adminResult.error);

  let userResult = { sent: false };
  if (booking.email) {
    const user = templates.userBookingConfirmationEmail(booking);
    userResult = await sendAndLog({
      entityType: 'booking', entityId: booking.id, recipientType: 'user',
      to: booking.email, subject: user.subject, html: user.html, text: user.text
    });
    if (userResult.error) errors.push(userResult.error);
  }

  return { adminEmailSent: adminResult.sent, userEmailSent: userResult.sent, errors };
}

export async function sendVinCheckEmails(vinCheck) {
  const errors = [];

  const admin = templates.adminNewVinCheckEmail(vinCheck);
  const adminResult = await sendAndLog({
    entityType: 'vin_check', entityId: vinCheck.id, recipientType: 'admin',
    to: getAdminRecipient(), subject: admin.subject, html: admin.html, text: admin.text
  });
  if (adminResult.error) errors.push(adminResult.error);

  // vin_checks records have no email field today (the VIN form doesn't
  // collect one) — this stays a no-op until that changes, on purpose.
  let userResult = { sent: false };
  if (vinCheck.email) {
    const user = templates.userVinCheckConfirmationEmail(vinCheck);
    userResult = await sendAndLog({
      entityType: 'vin_check', entityId: vinCheck.id, recipientType: 'user',
      to: vinCheck.email, subject: user.subject, html: user.html, text: user.text
    });
    if (userResult.error) errors.push(userResult.error);
  }

  return { adminEmailSent: adminResult.sent, userEmailSent: userResult.sent, errors };
}

/**
 * Admin-only notification for a successful payment — no user email yet
 * (see the task scope for this step). Reuses the same sendAndLog()
 * plumbing as the other three, so it's logged in email_logs the same way
 * (entityType: 'payment').
 */
export async function sendPaymentPaidEmail(payment) {
  const errors = [];

  const admin = templates.adminPaymentPaidEmail(payment);
  const adminResult = await sendAndLog({
    entityType: 'payment', entityId: payment.id, recipientType: 'admin',
    to: getAdminRecipient(), subject: admin.subject, html: admin.html, text: admin.text
  });
  if (adminResult.error) errors.push(adminResult.error);

  return { adminEmailSent: adminResult.sent, errors };
}

/** Admin-only notification when a report is auto-created after a payment
 * clears — no customer-facing email at all on this step (report delivery
 * to the customer is explicitly a later step). Same never-throws
 * contract as every other send*Emails function here: a failure here must
 * never prevent the report itself from being created. */
export async function sendReportCreatedEmail(report) {
  const errors = [];

  const admin = templates.adminReportCreatedEmail(report);
  const adminResult = await sendAndLog({
    entityType: 'report', entityId: report.id, recipientType: 'admin',
    to: getAdminRecipient(), subject: admin.subject, html: admin.html, text: admin.text
  });
  if (adminResult.error) errors.push(adminResult.error);

  return { adminEmailSent: adminResult.sent, errors };
}

/** Sends the customer their private report link — user-facing only, no
 * admin copy (the admin already knows, they're the one who triggered
 * this from admin-reports.html). Returns { userEmailSent, errors } so
 * the caller (POST /admin/reports/:id/send-to-customer) can decide
 * whether to actually transition the report to report_sent — see that
 * route in server.js for exactly why status only changes on a genuine
 * send, not unconditionally. */
export async function sendReportReadyEmail(report, publicLink) {
  const errors = [];

  if (!report.customerEmail) {
    return { userEmailSent: false, errors: ['Report has no customerEmail to send to.'] };
  }

  const user = templates.userReportReadyEmail(report, publicLink);
  const userResult = await sendAndLog({
    entityType: 'report', entityId: report.id, recipientType: 'user',
    to: report.customerEmail, subject: user.subject, html: user.html, text: user.text
  });
  if (userResult.error) errors.push(userResult.error);

  return { userEmailSent: userResult.sent, errors };
}

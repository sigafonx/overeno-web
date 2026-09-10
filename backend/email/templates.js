const APP_URL = process.env.APP_URL || 'http://localhost:8000';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderFieldsHtml(fields) {
  const rows = fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `
      <tr>
        <td style="padding:4px 14px 4px 0;color:#5B5748;white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:4px 0;font-weight:600;">${escapeHtml(value)}</td>
      </tr>`)
    .join('');
  return `<table cellpadding="0" cellspacing="0" style="font-family:sans-serif;font-size:14px;">${rows}</table>`;
}

function renderFieldsText(fields) {
  return fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

function wrapHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#1B2129;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="font-family:sans-serif;font-size:20px;margin:0 0 16px;">${escapeHtml(title)}</h2>
  ${bodyHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Admin notifications
// ---------------------------------------------------------------------------

export function adminNewLeadEmail(lead) {
  const subject = `New NEXIUM lead: ${lead.type}`;
  const fields = [
    ['ID', lead.id],
    ['Type', lead.type],
    ['Status', lead.status],
    ['Created', lead.createdAt],
    ['Company', lead.companyName],
    ['Contact', lead.contactName],
    ['Email', lead.email],
    ['Phone', lead.phone],
    ['City', lead.city],
    ['Source', lead.source],
    ['Message', lead.message]
  ];
  const link = `${APP_URL}/admin-leads.html`;
  const html = wrapHtml(subject, `${renderFieldsHtml(fields)}<p style="margin-top:20px;"><a href="${link}">${link}</a></p>`);
  const text = `${subject}\n\n${renderFieldsText(fields)}\n\n${link}`;
  return { subject, html, text };
}

export function adminNewBookingEmail(booking) {
  const subject = 'New NEXIUM inspection booking';
  const fields = [
    ['ID', booking.id],
    ['City', booking.city],
    ['Preferred slot', booking.preferredSlot],
    ['Contact', booking.contactName],
    ['Email', booking.email],
    ['Phone', booking.phone],
    ['VIN', booking.vin],
    ['Listing URL', booking.listingUrl],
    ['Message', booking.message]
  ];
  const link = `${APP_URL}/admin-bookings.html`;
  const html = wrapHtml(subject, `${renderFieldsHtml(fields)}<p style="margin-top:20px;"><a href="${link}">${link}</a></p>`);
  const text = `${subject}\n\n${renderFieldsText(fields)}\n\n${link}`;
  return { subject, html, text };
}

export function adminNewVinCheckEmail(vinCheck) {
  const subject = 'New NEXIUM VIN check';
  const result = vinCheck.result || {};
  const fields = [
    ['ID', vinCheck.id],
    ['VIN', vinCheck.vin],
    ['Risk level', result.riskLevel],
    ['Score', result.score],
    ['Demo result', result.isDemoResult ? 'yes' : 'no'],
    ['Source', vinCheck.source],
    ['Language', vinCheck.language]
  ];
  const link = `${APP_URL}/admin-vin-checks.html`;
  const html = wrapHtml(subject, `${renderFieldsHtml(fields)}<p style="margin-top:20px;"><a href="${link}">${link}</a></p>`);
  const text = `${subject}\n\n${renderFieldsText(fields)}\n\n${link}`;
  return { subject, html, text };
}

export function adminPaymentPaidEmail(payment) {
  const subject = `NEXIUM payment received: ${payment.productCode}`;
  const amountFormatted = `${(payment.amount / 100).toFixed(2)} ${payment.currency}`;
  const fields = [
    ['Payment ID', payment.id],
    ['Product', payment.productCode],
    ['Amount', amountFormatted],
    ['Currency', payment.currency],
    ['Provider', payment.provider],
    ['Entity type', payment.entityType],
    ['Entity ID', payment.entityId],
    ['Customer email', payment.customerEmail],
    ['Paid at', payment.paidAt]
  ];
  const link = `${APP_URL}/admin-payments.html`;
  const html = wrapHtml(subject, `${renderFieldsHtml(fields)}<p style="margin-top:20px;"><a href="${link}">${link}</a></p>`);
  const text = `${subject}\n\n${renderFieldsText(fields)}\n\n${link}`;
  return { subject, html, text };
}

export function adminReportCreatedEmail(report) {
  const subject = `NEXIUM report created: ${report.reportType}`;
  const fields = [
    ['Report ID', report.id],
    ['Report type', report.reportType],
    ['Entity type', report.entityType],
    ['Entity ID', report.entityId],
    ['Status', report.status],
    ['Customer email', report.customerEmail],
    ['Created at', report.createdAt]
  ];
  const link = `${APP_URL}/admin-reports.html`;
  const html = wrapHtml(subject, `${renderFieldsHtml(fields)}<p style="margin-top:20px;"><a href="${link}">${link}</a></p>`);
  const text = `${subject}\n\n${renderFieldsText(fields)}\n\n${link}`;
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// User confirmations — deliberately cautious wording: no promises about
// outcome or exact timing, since none of this is automated yet.
// ---------------------------------------------------------------------------

export function userLeadConfirmationEmail() {
  const subject = 'NEXIUM — we received your request';
  const bodyHtml = `
    <p>Thanks — we received your request.</p>
    <p>We'll review the details and get back to you. This is an automatic
    confirmation, not a decision, and we can't promise an exact timeline.</p>
  `;
  const text = `Thanks — we received your request.\n\nWe'll review the details and get back to you. This is an automatic confirmation, not a decision, and we can't promise an exact timeline.`;
  return { subject, html: wrapHtml(subject, bodyHtml), text };
}

export function userBookingConfirmationEmail() {
  const subject = 'NEXIUM — inspection request received';
  const bodyHtml = `
    <p>Your inspection request has been received — our team will review the details.</p>
    <p>The inspection isn't confirmed until an admin confirms it on our side.
    We'll reach out if we need anything else from you.</p>
  `;
  const text = `Your inspection request has been received — our team will review the details.\n\nThe inspection isn't confirmed until an admin confirms it on our side. We'll reach out if we need anything else from you.`;
  return { subject, html: wrapHtml(subject, bodyHtml), text };
}

export function userVinCheckConfirmationEmail() {
  const subject = 'NEXIUM — VIN check complete';
  const bodyHtml = `
    <p>Your VIN check is ready. This is a <strong>demo result</strong>, not an
    official vehicle history report.</p>
    <p>For a fuller picture before you buy, you can book an independent
    inspector through the site.</p>
  `;
  const text = `Your VIN check is ready. This is a demo result, not an official vehicle history report.\n\nFor a fuller picture before you buy, you can book an independent inspector through the site.`;
  return { subject, html: wrapHtml(subject, bodyHtml), text };
}

/** The only email in this file with a real link to something the
 * customer can actually open — a private, token-protected report page
 * (see GET /reports/public/:token in server.js). publicLink is the full
 * URL (report.html?token=...), built by the caller, not here — this
 * function just drops it into the email body. */
export function userReportReadyEmail(report, publicLink) {
  const subject = 'NEXIUM — your report is ready';
  const bodyHtml = `
    <p>Your report is ready — you can view it here:</p>
    <p style="margin:20px 0;"><a href="${publicLink}">${publicLink}</a></p>
    <p style="font-size:0.85rem;color:#6b6b6b;">This link is private — please don't
    forward it to anyone else. A report like this reduces risk, but it doesn't
    guarantee the vehicle is free of defects — always inspect the vehicle in
    person before you buy.</p>
  `;
  const text = `Your report is ready — you can view it here:\n\n${publicLink}\n\nThis link is private — please don't forward it to anyone else. A report like this reduces risk, but it doesn't guarantee the vehicle is free of defects — always inspect the vehicle in person before you buy.`;
  return { subject, html: wrapHtml(subject, bodyHtml), text };
}

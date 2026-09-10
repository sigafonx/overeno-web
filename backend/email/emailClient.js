import nodemailer from 'nodemailer';

// ---------------------------------------------------------------------------
// This module is the ONLY place that knows about nodemailer/SMTP. Callers
// (emailService.js, and through it server.js) only ever use sendEmail()
// and isEmailEnabled() — swapping SMTP for Resend/SendGrid/Mailgun later
// means rewriting the inside of this file only, nothing upstream.
// ---------------------------------------------------------------------------

const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@nexium.example';
const FROM_NAME = process.env.FROM_NAME || 'NEXIUM';

function buildTransporter() {
  const host = process.env.SMTP_HOST;
  if (!host) return null; // EMAIL_ENABLED=true but nothing configured yet

  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER || undefined;
  const pass = process.env.SMTP_PASS || undefined;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined
  });
}

let transporter = null;
if (EMAIL_ENABLED) {
  try {
    transporter = buildTransporter();
    if (!transporter) {
      console.warn('[email] EMAIL_ENABLED=true but SMTP_HOST is not set — emails will be logged as failed until SMTP is configured.');
    }
  } catch (err) {
    console.warn('[email] Failed to create SMTP transporter:', err.message);
    transporter = null;
  }
}

export function isEmailEnabled() {
  return EMAIL_ENABLED;
}

/**
 * Sends one email. NEVER throws — always resolves to a result object, so a
 * broken SMTP config can never take down the request that triggered it:
 *   { ok: true }
 *   { ok: false, skipped: true, reason: '...' }   // disabled or no recipient
 *   { ok: false, error: '...' }                    // SMTP genuinely failed
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!EMAIL_ENABLED) {
    return { ok: false, skipped: true, reason: 'EMAIL_ENABLED is false' };
  }
  if (!to) {
    return { ok: false, skipped: true, reason: 'No recipient address' };
  }
  if (!transporter) {
    return { ok: false, error: 'SMTP is not configured (SMTP_HOST missing or transporter failed to initialize).' };
  }

  try {
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      html,
      text
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { db, DB_PATH } from './db/database.js';
import {
  insertLead, findAllLeads, findLeadById,
  updateLeadStatusById, updateLeadNoteById, deleteLeadByIdRepo, updateLeadAssignedAgentById
} from './db/repositories/leadsRepository.js';
import {
  insertBooking, findAllBookings, findBookingById,
  updateBookingStatusById, updateBookingNoteById, deleteBookingByIdRepo, updateBookingAssignedAgentById
} from './db/repositories/bookingsRepository.js';
import {
  insertVinCheck, findAllVinChecks, findVinCheckById, updateVinCheckNoteById, updateVinCheckAssignedAgentById
} from './db/repositories/vinChecksRepository.js';
import { findAllEmailLogs, updateReviewState } from './db/repositories/emailLogsRepository.js';
import { sendLeadEmails, sendBookingEmails, sendVinCheckEmails } from './email/emailService.js';
import { isEmailEnabled } from './email/emailClient.js';
import { findAllPayments, findPaymentById, updatePaymentNote, updatePaymentAssignedAgent } from './db/repositories/paymentsRepository.js';
import { createCheckout, validateCheckoutPayload, applyWebhookEvent, handleMockWebhook } from './payments/paymentService.js';
import { getPaymentProvider } from './payments/paymentProvider.js';
import { PAYMENTS_ENABLED, PAYMENT_PROVIDER_NAME } from './payments/paymentConfig.js';
import {
  AGENT_ROLES, insertAgent, findAllAgents, findAgentById, agentExists, updateAgentById
} from './db/repositories/agentsRepository.js';
import {
  REPORT_STATUSES, REPORT_TYPES, REPORT_ENTITY_TYPES,
  listReports, listAllMatchingReports, getReportById, updateReportStatus, updateReportNote, updateReportSummary, listStatusHistory, touchReport,
  generatePublicToken, revokePublicToken, getReportByPublicToken, markDelivered
} from './db/repositories/reportsRepository.js';
import {
  DRAFT_READY_REQUIRED_SECTION_KEYS,
  listSections, getSection, updateSection, reorderSections, resetDefaultSections
} from './db/repositories/reportSectionsRepository.js';
import { sendReportReadyEmail } from './email/emailService.js';
import { AI_ENABLED, AI_PROVIDER_NAME, AI_MONTHLY_BUDGET_LIMIT } from './ai/aiConfig.js';
import { generateVinResult } from './vin/demoVinProvider.js';
import { VIN_PROVIDER_NAME, VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK } from './vin/vinConfig.js';
import { getVinProvider } from './vin/vinProvider.js';
import { runVinProviderCheck } from './vin/vinCostLogger.js';
import { listVinProviderRunsForVinCheck } from './db/repositories/vinProviderRunsRepository.js';
import { validateBusinessRunRequest, runBusinessAgent } from './ai/businessAgentRunner.js';
import { AGENT_TASK_STATUSES, listAgentTasks, listAllMatchingAgentTasks, getAgentTaskById, updateAgentTaskStatus } from './db/repositories/agentTasksRepository.js';
import { insertInspector, findAllInspectors, findInspectorById, inspectorExists, updateInspectorById } from './db/repositories/inspectorsRepository.js';
import {
  INSPECTION_JOB_STATUSES, createInspectionJob, getInspectionJobById, getInspectionJobByBookingId,
  listInspectionJobs, listAllMatchingInspectionJobs, updateInspectionJob
} from './db/repositories/inspectionJobsRepository.js';
import {
  CHECKLIST_ITEM_VALUES, listChecklistItems, getChecklistItemById,
  createDefaultChecklistItems, updateChecklistItem
} from './db/repositories/inspectionChecklistRepository.js';
import { DEALER_STATUSES, insertDealer, findAllDealers, findDealerById, findDealerByEmail, dealerExists, updateDealerById } from './db/repositories/dealersRepository.js';
import { DEALER_VEHICLE_STATUSES, insertDealerVehicle, findAllDealerVehicles, findDealerVehicleById, dealerVehicleExists, updateDealerVehicleById } from './db/repositories/dealerVehiclesRepository.js';
import {
  BADGE_STATUSES, createBadgeRequest, getBadgeById, getBadgeByCode, hasActiveBadgeForVehicle,
  listBadges, listAllMatchingBadges, updateBadgeStatus
} from './db/repositories/verifiedBadgesRepository.js';
import { REVENUE_SHARE_LEDGER_STATUSES, MONTHLY_PAYOUT_STATUSES, getRevenueShareSettings, updateRevenueShareSettings } from './db/repositories/revenueShareRepository.js';
import {
  listLedger, listAllMatchingLedgerEntries,
  listPayouts, listAllMatchingPayoutRecords, calculateMonthlyPayout, createMonthlyPayout, markPayoutPaid
} from './revenueShare/revenueShareService.js';
import { getPayoutById as getRevenueSharePayoutById, updateMonthlyPayout as updateRevenueSharePayout } from './db/repositories/revenueShareRepository.js';
import { validateRunRequest, runAgent, seedPromptsIfNeeded } from './ai/orchestrator.js';
import { applyRunToReport } from './ai/applyToReport.js';
import { AI_OUTPUT_DISCLAIMER } from './ai/safety/disclaimers.js';
import { listAiRuns, listAllMatchingAiRuns, getAiRunById, updateAiRunReview, markAiRunApplied } from './db/repositories/aiRunsRepository.js';

const PORT = process.env.PORT || 3001;
// Used only to build the public report link (report.html?token=...) sent
// in the customer email and returned to the admin for the "copy link"
// button — the frontend page itself lives wherever the static site is
// served, this backend has no opinion on that beyond this one URL.
const APP_URL = process.env.APP_URL || 'http://localhost:8000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change_me';

// CORS_ORIGINS in .env is a comma-separated list, e.g.
// "https://nexium.cz,https://www.nexium.cz". Falls back to the local
// dev ports below when unset/empty — safe for local development, and
// impossible to accidentally leave wide-open (no wildcard fallback).
const LOCALHOST_DEV_ORIGINS = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];
const CORS_ORIGINS_ENV = (process.env.CORS_ORIGINS || '').trim();
const CORS_ALLOWED_ORIGINS = CORS_ORIGINS_ENV
  ? CORS_ORIGINS_ENV.split(',').map((o) => o.trim()).filter(Boolean)
  : LOCALHOST_DEV_ORIGINS;
const CORS_IS_LOCALHOST_ONLY = CORS_ALLOWED_ORIGINS.every((o) => o.includes('localhost') || o.includes('127.0.0.1'));

// ---------------------------------------------------------------------------
// Lightweight in-memory rate limiter for public write endpoints (leads,
// bookings, vin/check, payments/checkout) — a basic abuse safety net, not
// a replacement for real rate limiting at a reverse proxy/WAF in front of
// this in production (see backend/README.md's production checklist).
// Deliberately generous so normal usage and automated tests never trip
// it. In-memory only: resets on restart, and doesn't coordinate across
// multiple backend processes — matches this project's existing
// single-process SQLite assumption (see "Известные ограничения").
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30; // per IP, per endpoint, per minute

const rateLimitBuckets = new Map(); // `${ip}:${routeKey}` -> array of request timestamps

function rateLimit(routeKey) {
  return (req, res, next) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = `${ip}:${routeKey}`;
    const now = Date.now();

    let timestamps = rateLimitBuckets.get(key);
    if (!timestamps) {
      timestamps = [];
      rateLimitBuckets.set(key, timestamps);
    }

    while (timestamps.length > 0 && now - timestamps[0] > RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }

    if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
      return res.status(429).json({
        ok: false,
        error: 'RATE_LIMITED',
        message: 'Too many requests. Please try again in a minute.'
      });
    }

    timestamps.push(now);
    next();
  };
}

// Periodic cleanup so `rateLimitBuckets` doesn't grow forever on a
// long-running process — cheap, and only removes buckets that are already
// fully outside the window (so it never affects an active limit).
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitBuckets) {
    while (timestamps.length > 0 && now - timestamps[0] > RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length === 0) rateLimitBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref(); // unref so this never keeps the process alive on its own (e.g. in tests)

const LEAD_TYPES = ['dealer_request', 'inspector_request', 'final_cta', 'email_lead'];
const MESSAGE_MAX_LENGTH = 2000;
const NOTE_MAX_LENGTH = 3000;
// Deliberately separate from NOTE_MAX_LENGTH above: leads/bookings notes
// are silently truncated at their limit, but a VIN-check note that's too
// long should be a real 400 (see validateVinCheckNotePayload below).
const VIN_CHECK_NOTE_MAX_LENGTH = 5000;
const EMAIL_LOG_NOTE_MAX_LENGTH = 5000;
const PAYMENT_NOTE_MAX_LENGTH = 5000;
const ADMIN_STATUSES = ['new', 'contacted', 'qualified', 'not_qualified', 'waiting_reply', 'converted', 'spam', 'archived'];
const ADMIN_BOOKING_STATUSES = [
  'new', 'contacted', 'waiting_payment', 'paid', 'inspector_needed',
  'inspector_assigned', 'inspection_scheduled', 'completed', 'cancelled', 'spam', 'archived'
];

// Only these fields are ever persisted. Anything else in the request body
// (createdAtClient, unknown extras, etc.) is silently dropped.
const STORED_FIELDS = [
  'companyName', 'contactName', 'email', 'phone', 'city',
  'vehiclesCount', 'qualification', 'availability', 'message',
  'language', 'source', 'pageUrl'
];

const BOOKING_STORED_FIELDS = [
  'vin', 'listingUrl', 'city', 'preferredSlot', 'contactName', 'email',
  'phone', 'message', 'language', 'source', 'pageUrl'
];

const VIN_MIN_LENGTH = 5;
const VIN_MAX_LENGTH = 24;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Returns an array of human-readable problem strings; empty = valid. */
function validateLead(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }

  const problems = [];
  const type = str(payload.type);

  if (!type) {
    problems.push('type is required.');
  } else if (!LEAD_TYPES.includes(type)) {
    problems.push(`Unknown lead type "${type}".`);
  }

  if (!isValidEmail(payload.email)) {
    problems.push('A valid email is required.');
  }

  if (type === 'dealer_request') {
    if (!str(payload.companyName)) problems.push('companyName is required for dealer_request.');
    if (!str(payload.contactName)) problems.push('contactName is required for dealer_request.');
    if (!str(payload.city)) problems.push('city is required for dealer_request.');
  }

  if (type === 'inspector_request') {
    if (!str(payload.contactName)) problems.push('contactName is required for inspector_request.');
    if (!str(payload.city)) problems.push('city is required for inspector_request.');
  }

  // final_cta / email_lead: only the generic email check above applies.

  return problems;
}

function sanitizeLead(payload) {
  const clean = {};
  for (const key of STORED_FIELDS) {
    const value = str(payload[key]);
    if (!value) continue;
    clean[key] = key === 'message' ? value.slice(0, MESSAGE_MAX_LENGTH) : value;
  }
  if (!clean.language) clean.language = 'unknown';
  if (!clean.source) clean.source = 'website';
  return clean;
}

function generateLeadId() {
  return 'lead_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Booking validation rules: city and preferredSlot are always required;
 * at least one of email/phone is required so someone can actually be
 * contacted. vin/listingUrl/contactName are all optional.
 */
function validateBooking(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }

  const problems = [];

  if (!str(payload.city)) problems.push('city is required.');
  if (!str(payload.preferredSlot)) problems.push('preferredSlot is required.');

  const hasEmail = !!str(payload.email);
  const hasPhone = !!str(payload.phone);
  if (!hasEmail && !hasPhone) {
    problems.push('Either email or phone is required.');
  }
  if (hasEmail && !isValidEmail(payload.email)) {
    problems.push('email must look like a valid email address.');
  }

  return problems;
}

function sanitizeBooking(payload) {
  const clean = {};
  for (const key of BOOKING_STORED_FIELDS) {
    let value = str(payload[key]);
    if (!value) continue;
    if (key === 'vin') value = value.toUpperCase();
    if (key === 'message') value = value.slice(0, MESSAGE_MAX_LENGTH);
    clean[key] = value;
  }
  if (!clean.language) clean.language = 'unknown';
  if (!clean.source) clean.source = 'website';
  return clean;
}

function generateBookingId() {
  return 'booking_' + crypto.randomBytes(6).toString('hex');
}

/**
 * VIN validation/normalization rules: trim, drop internal whitespace,
 * uppercase, then require 5-24 alphanumeric characters. This is a demo
 * check (not a real VIN checksum validator), so the bar is just "looks
 * like a plausible identifier", matching what the frontend already
 * allowed via its <input maxlength="24">.
 */
function normalizeVin(raw) {
  return String(raw || '').replace(/\s+/g, '').toUpperCase();
}

function validateVinPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { problems: ['Request body must be a JSON object.'], vin: '' };
  }

  const vin = normalizeVin(payload.vin);
  const problems = [];

  if (!vin) {
    problems.push('vin is required.');
  } else {
    if (vin.length < VIN_MIN_LENGTH) problems.push(`vin must be at least ${VIN_MIN_LENGTH} characters.`);
    if (vin.length > VIN_MAX_LENGTH) problems.push(`vin must be at most ${VIN_MAX_LENGTH} characters.`);
    if (!/^[A-Z0-9]+$/.test(vin)) problems.push('vin may only contain letters and digits.');
  }

  return { problems, vin };
}

/**
 * Validation for PATCH /admin/vin-checks/:id/note. Returns an array of
 * human-readable problem strings; empty = valid. Deliberately strict about
 * type (a real 400 for a non-string, unlike the lenient str()-coercion
 * used elsewhere) since this is an admin-only free-text field where a
 * silent wrong-type write would be confusing to debug later.
 */
function validateVinCheckNotePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  if (payload.internalNote === undefined) {
    return ['internalNote is required.'];
  }
  if (typeof payload.internalNote !== 'string') {
    return ['internalNote must be a string.'];
  }
  if (payload.internalNote.length > VIN_CHECK_NOTE_MAX_LENGTH) {
    return [`internalNote must be at most ${VIN_CHECK_NOTE_MAX_LENGTH} characters.`];
  }
  return [];
}

/** Same shape as validateVinCheckNotePayload — internalNote is required
 * (missing key -> 400), a string, empty allowed, capped at 5000 chars. */
function validatePaymentNotePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  if (payload.internalNote === undefined) {
    return ['internalNote is required.'];
  }
  if (typeof payload.internalNote !== 'string') {
    return ['internalNote must be a string.'];
  }
  if (payload.internalNote.length > PAYMENT_NOTE_MAX_LENGTH) {
    return [`internalNote must be at most ${PAYMENT_NOTE_MAX_LENGTH} characters.`];
  }
  return [];
}

const AGENT_NAME_MAX_LENGTH = 200;

function validateCreateAgentPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  const name = str(payload.name);
  if (!name) problems.push('name is required.');
  else if (name.length > AGENT_NAME_MAX_LENGTH) problems.push(`name must be at most ${AGENT_NAME_MAX_LENGTH} characters.`);

  const role = str(payload.role);
  if (!role) problems.push('role is required.');
  else if (!AGENT_ROLES.includes(role)) problems.push(`role must be one of: ${AGENT_ROLES.join(', ')}.`);

  if (payload.email !== undefined && payload.email !== null && payload.email !== '' && !isValidEmail(payload.email)) {
    problems.push('email must look like a valid email address.');
  }
  if (payload.active !== undefined && typeof payload.active !== 'boolean') {
    problems.push('active must be a boolean.');
  }

  return problems;
}

function validateUpdateAgentPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }

  const hasName = payload.name !== undefined;
  const hasRole = payload.role !== undefined;
  const hasEmail = payload.email !== undefined;
  const hasActive = payload.active !== undefined;

  if (!hasName && !hasRole && !hasEmail && !hasActive) {
    return ['Request body must include at least one of: name, role, email, active.'];
  }

  const problems = [];
  if (hasName) {
    const name = str(payload.name);
    if (!name) problems.push('name cannot be empty.');
    else if (name.length > AGENT_NAME_MAX_LENGTH) problems.push(`name must be at most ${AGENT_NAME_MAX_LENGTH} characters.`);
  }
  if (hasRole) {
    const role = str(payload.role);
    if (!role || !AGENT_ROLES.includes(role)) problems.push(`role must be one of: ${AGENT_ROLES.join(', ')}.`);
  }
  if (hasEmail && payload.email !== null && payload.email !== '' && !isValidEmail(payload.email)) {
    problems.push('email must look like a valid email address.');
  }
  if (hasActive && typeof payload.active !== 'boolean') {
    problems.push('active must be a boolean.');
  }

  return problems;
}

/** Shared by all four "assign agent to X" endpoints. assignedAgentId must
 * be present (use null to unassign) and, if not null, must reference a
 * real agent — checked by the route handler via agentExists(), not here. */
function validateAssignPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  if (payload.assignedAgentId === undefined) {
    return ['assignedAgentId is required (use null to unassign).'];
  }
  if (payload.assignedAgentId !== null && typeof payload.assignedAgentId !== 'string') {
    return ['assignedAgentId must be a string or null.'];
  }
  return [];
}

const REPORT_NOTE_MAX_LENGTH = 5000;
const REPORT_TEXT_FIELD_MAX_LENGTH = 20000; // summary can legitimately be long-form text

function validateReportStatusPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];
  const status = str(payload.status);
  if (!status) problems.push('status is required.');
  else if (!REPORT_STATUSES.includes(status)) problems.push(`status must be one of: ${REPORT_STATUSES.join(', ')}.`);

  if (payload.reason !== undefined && typeof payload.reason !== 'string') {
    problems.push('reason must be a string.');
  }
  return problems;
}

function validateReportNotePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  if (payload.internalNote === undefined) {
    return ['internalNote is required.'];
  }
  if (typeof payload.internalNote !== 'string') {
    return ['internalNote must be a string.'];
  }
  if (payload.internalNote.length > REPORT_NOTE_MAX_LENGTH) {
    return [`internalNote must be at most ${REPORT_NOTE_MAX_LENGTH} characters.`];
  }
  return [];
}

function validateReportSummaryPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }

  const hasTitle = payload.title !== undefined;
  const hasSummary = payload.summary !== undefined;
  const hasVerdict = payload.verdict !== undefined;
  const hasRiskLevel = payload.riskLevel !== undefined;
  const hasScore = payload.score !== undefined;

  if (!hasTitle && !hasSummary && !hasVerdict && !hasRiskLevel && !hasScore) {
    return ['Request body must include at least one of: title, summary, verdict, riskLevel, score.'];
  }

  const problems = [];
  if (hasTitle && payload.title !== null && typeof payload.title !== 'string') problems.push('title must be a string or null.');
  if (hasTitle && typeof payload.title === 'string' && payload.title.length > 300) problems.push('title must be at most 300 characters.');
  if (hasSummary && payload.summary !== null && typeof payload.summary !== 'string') problems.push('summary must be a string or null.');
  if (hasSummary && typeof payload.summary === 'string' && payload.summary.length > REPORT_TEXT_FIELD_MAX_LENGTH) problems.push(`summary must be at most ${REPORT_TEXT_FIELD_MAX_LENGTH} characters.`);
  if (hasVerdict && payload.verdict !== null && typeof payload.verdict !== 'string') problems.push('verdict must be a string or null.');
  if (hasVerdict && typeof payload.verdict === 'string' && payload.verdict.length > 300) problems.push('verdict must be at most 300 characters.');
  if (hasRiskLevel && payload.riskLevel !== null && typeof payload.riskLevel !== 'string') problems.push('riskLevel must be a string or null.');
  if (hasScore && payload.score !== null && (!Number.isInteger(payload.score) || payload.score < 0 || payload.score > 100)) {
    problems.push('score must be an integer between 0 and 100, or null.');
  }

  return problems;
}

const REPORT_SECTION_CONTENT_MAX_LENGTH = 20000;
const REPORT_SECTION_TITLE_MAX_LENGTH = 300;

function validateReportSectionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  const title = str(payload.title);
  if (!title) problems.push('title is required.');
  else if (title.length > REPORT_SECTION_TITLE_MAX_LENGTH) problems.push(`title must be at most ${REPORT_SECTION_TITLE_MAX_LENGTH} characters.`);

  if (payload.content !== undefined && payload.content !== null && typeof payload.content !== 'string') {
    problems.push('content must be a string or null.');
  }
  if (typeof payload.content === 'string' && payload.content.length > REPORT_SECTION_CONTENT_MAX_LENGTH) {
    problems.push(`content must be at most ${REPORT_SECTION_CONTENT_MAX_LENGTH} characters.`);
  }

  return problems;
}

function validateReorderPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  if (!Array.isArray(payload.orderedIds)) {
    return ['orderedIds is required and must be an array.'];
  }
  if (payload.orderedIds.length === 0) {
    return ['orderedIds must not be empty.'];
  }
  if (payload.orderedIds.some((id) => typeof id !== 'string' || !id)) {
    return ['orderedIds must be an array of non-empty strings.'];
  }
  return [];
}

function validateAgentTaskStatusPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const status = str(payload.status);
  if (!status) return ['status is required.'];
  if (!AGENT_TASK_STATUSES.includes(status)) {
    return [`status must be one of: ${AGENT_TASK_STATUSES.join(', ')}.`];
  }
  return [];
}

function validateInspectorPayload(payload, { isCreate }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  if (isCreate && !str(payload.name)) {
    problems.push('name is required.');
  }
  if (payload.name !== undefined && !str(payload.name)) {
    problems.push('name cannot be empty.');
  }
  if (payload.email !== undefined && payload.email !== null && str(payload.email) && !isValidEmail(payload.email)) {
    problems.push('email must look like a valid email address.');
  }
  if (payload.active !== undefined && typeof payload.active !== 'boolean') {
    problems.push('active must be a boolean.');
  }

  return problems;
}

function validateCreateInspectionJobPayload(payload) {
  if (payload === undefined || payload === null) return [];
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object (or omitted).'];
  }
  const problems = [];
  if (payload.inspectorId !== undefined && payload.inspectorId !== null && !inspectorExists(payload.inspectorId)) {
    problems.push(`Unknown inspectorId "${payload.inspectorId}".`);
  }
  return problems;
}

function validateUpdateInspectionJobPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  if (payload.status !== undefined && !INSPECTION_JOB_STATUSES.includes(payload.status)) {
    problems.push(`status must be one of: ${INSPECTION_JOB_STATUSES.join(', ')}.`);
  }
  if (payload.inspectorId !== undefined && payload.inspectorId !== null && !inspectorExists(payload.inspectorId)) {
    problems.push(`Unknown inspectorId "${payload.inspectorId}".`);
  }
  if (payload.scheduledAt !== undefined && payload.scheduledAt !== null && Number.isNaN(new Date(payload.scheduledAt).getTime())) {
    problems.push('scheduledAt must be a valid date/time, or null.');
  }

  return problems;
}

function validateChecklistItemPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  if (payload.value !== undefined && payload.value !== null && !CHECKLIST_ITEM_VALUES.includes(payload.value)) {
    problems.push(`value must be one of: ${CHECKLIST_ITEM_VALUES.join(', ')}, or null.`);
  }
  if (payload.comment !== undefined && payload.comment !== null && typeof payload.comment !== 'string') {
    problems.push('comment must be a string or null.');
  }
  if (typeof payload.comment === 'string' && payload.comment.length > 3000) {
    problems.push('comment must be at most 3000 characters.');
  }

  return problems;
}

function validateDealerPayload(payload, { isCreate }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  if (isCreate && !str(payload.companyName)) {
    problems.push('companyName is required.');
  }
  if (payload.companyName !== undefined && !str(payload.companyName)) {
    problems.push('companyName cannot be empty.');
  }
  if (payload.email !== undefined && payload.email !== null && str(payload.email) && !isValidEmail(payload.email)) {
    problems.push('email must look like a valid email address.');
  }
  if (payload.status !== undefined && !DEALER_STATUSES.includes(payload.status)) {
    problems.push(`status must be one of: ${DEALER_STATUSES.join(', ')}.`);
  }

  return problems;
}

function validateDealerVehiclePayload(payload, { isCreate }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  if (isCreate && !str(payload.dealerId)) {
    problems.push('dealerId is required.');
  }
  if (isCreate && payload.dealerId && !dealerExists(payload.dealerId)) {
    problems.push(`Unknown dealerId "${payload.dealerId}".`);
  }
  if (payload.year !== undefined && payload.year !== null) {
    const year = Number(payload.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      problems.push('year must be a valid 4-digit year, or null.');
    }
  }
  if (payload.status !== undefined && !DEALER_VEHICLE_STATUSES.includes(payload.status)) {
    problems.push(`status must be one of: ${DEALER_VEHICLE_STATUSES.join(', ')}.`);
  }

  return problems;
}

function validateBadgeStatusPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  const status = str(payload.status);
  if (!status) {
    problems.push('status is required.');
  } else if (!BADGE_STATUSES.includes(status) || status === 'expired') {
    // 'expired' is deliberately not settable by an admin — it's a lazy,
    // automatic transition based on expiresAt (see
    // verifiedBadgesRepository.js's withLazyExpiry()), never something
    // to PATCH into directly.
    problems.push(`status must be one of: requested, approved, rejected, revoked.`);
  }
  if (payload.expiresAt !== undefined && payload.expiresAt !== null && Number.isNaN(new Date(payload.expiresAt).getTime())) {
    problems.push('expiresAt must be a valid date/time, or null.');
  }

  return problems;
}

// A run of 12+ consecutive digits is the signature of a full card/
// account number — reject it outright rather than trying to guess
// which specific field format is "safe enough". payoutRecipientMasked
// is meant for something like "Wise ****1234" or a partially-hidden
// email, never a real, usable account identifier.
function looksLikeFullCardOrAccountNumber(value) {
  return /\d{12,}/.test(String(value || '').replace(/[\s-]/g, ''));
}

function isValidIanaTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validateRevenueShareSettingsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
    problems.push('enabled must be a boolean.');
  }
  if (payload.sharePercent !== undefined) {
    const n = Number(payload.sharePercent);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      problems.push('sharePercent must be an integer between 0 and 100.');
    }
  }
  if (payload.timezone !== undefined && !isValidIanaTimezone(payload.timezone)) {
    problems.push('timezone must be a valid IANA timezone name (e.g. "Europe/Prague").');
  }
  if (payload.payoutDay !== undefined) {
    const n = Number(payload.payoutDay);
    if (!Number.isInteger(n) || n < 1 || n > 28) {
      problems.push('payoutDay must be an integer between 1 and 28 (28 chosen so every month has that day, including February).');
    }
  }
  if (payload.payoutTime !== undefined && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(payload.payoutTime))) {
    problems.push('payoutTime must be in HH:mm 24-hour format (e.g. "10:00").');
  }
  if (payload.payoutRecipientMasked !== undefined && payload.payoutRecipientMasked !== null && looksLikeFullCardOrAccountNumber(payload.payoutRecipientMasked)) {
    problems.push('payoutRecipientMasked looks like it contains a full card/account number — only a masked value (e.g. "Wise ****1234") is accepted here, never the real number.');
  }

  return problems;
}

function validateMonthKeyPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(payload.monthKey || ''))) {
    return ['monthKey is required and must be in "YYYY-MM" format (e.g. "2026-09").'];
  }
  return [];
}

function validatePayoutNotePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  if (payload.internalNote !== undefined && payload.internalNote !== null && typeof payload.internalNote !== 'string') {
    return ['internalNote must be a string or null.'];
  }
  return [];
}

const AI_REVIEW_NOTE_MAX_LENGTH = 5000;

function validateAiReviewPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }
  const problems = [];

  if (payload.approved === undefined) {
    problems.push('approved is required (true or false).');
  } else if (typeof payload.approved !== 'boolean') {
    problems.push('approved must be a boolean (true or false).');
  }

  if (payload.reviewNote !== undefined && payload.reviewNote !== null && typeof payload.reviewNote !== 'string') {
    problems.push('reviewNote must be a string or null.');
  }
  if (typeof payload.reviewNote === 'string' && payload.reviewNote.length > AI_REVIEW_NOTE_MAX_LENGTH) {
    problems.push(`reviewNote must be at most ${AI_REVIEW_NOTE_MAX_LENGTH} characters.`);
  }

  return problems;
}

/**
 * Soft business rule for report status transitions (see server.js's
 * PATCH /admin/reports/:id/status) — not a hard schema constraint, just
 * a check run before the transition is allowed:
 *   draft_ready  -> overview/final_verdict/disclaimer sections must each
 *                   have non-empty (trimmed) content.
 *   report_ready -> EVERY section currently on the report must have
 *                   non-empty (trimmed) content — the whole report
 *                   should be readable before calling it ready.
 * Any other target status has no section requirement. Returns an array
 * of human-readable problem strings; empty = transition is allowed.
 */
function validateReportStatusTransition(reportId, targetStatus) {
  if (targetStatus !== 'draft_ready' && targetStatus !== 'report_ready') {
    return [];
  }

  const sections = listSections(reportId);
  const isEmpty = (section) => !section || !str(section.content);

  if (targetStatus === 'draft_ready') {
    const missing = DRAFT_READY_REQUIRED_SECTION_KEYS.filter((key) => {
      const section = sections.find((s) => s.sectionKey === key);
      return isEmpty(section);
    });
    if (missing.length > 0) {
      return [`Cannot move to draft_ready — these sections are still empty: ${missing.join(', ')}.`];
    }
    return [];
  }

  // report_ready: every section that exists on this report must be filled.
  const emptySections = sections.filter(isEmpty).map((s) => s.sectionKey);
  if (emptySections.length > 0) {
    return [`Cannot move to report_ready — these sections are still empty: ${emptySections.join(', ')}.`];
  }
  return [];
}

/**
 * Validation for PATCH /admin/email-logs/:id/review. All three payload
 * keys are optional and independent — but at least one must be present
 * (an empty `{}` payload is a 400, not a no-op success).
 */
function validateEmailLogReviewPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }

  const hasReviewed = payload.reviewed !== undefined;
  const hasResolved = payload.resolved !== undefined;
  const hasNote = payload.internalNote !== undefined;

  if (!hasReviewed && !hasResolved && !hasNote) {
    return ['Request body must include at least one of: reviewed, resolved, internalNote.'];
  }

  const problems = [];
  if (hasReviewed && typeof payload.reviewed !== 'boolean') {
    problems.push('reviewed must be a boolean.');
  }
  if (hasResolved && typeof payload.resolved !== 'boolean') {
    problems.push('resolved must be a boolean.');
  }
  if (hasNote) {
    if (typeof payload.internalNote !== 'string') {
      problems.push('internalNote must be a string.');
    } else if (payload.internalNote.length > EMAIL_LOG_NOTE_MAX_LENGTH) {
      problems.push(`internalNote must be at most ${EMAIL_LOG_NOTE_MAX_LENGTH} characters.`);
    }
  }

  return problems;
}

function generateVinCheckId() {
  return 'vincheck_' + crypto.randomBytes(6).toString('hex');
}

// hashVin()/generateVinResult() used to live here — moved verbatim (no
// behavior change) to backend/vin/demoVinProvider.js as part of the VIN
// provider adapter architecture. Imported from there now — see this
// file's import block near the top for `generateVinResult`.

// ---------------------------------------------------------------------------
// Storage — backed by SQLite (backend/data/overeno.sqlite) via the
// repositories in backend/db/repositories/. Every function here keeps the
// exact name, signature and return shape the route handlers below already
// expect, so nothing past this section needed to change for the migration
// from JSON files.
// ---------------------------------------------------------------------------

function readLeads() {
  return findAllLeads();
}

function appendLead(lead) {
  return insertLead(lead);
}

function updateLeadStatus(id, status) {
  const lead = updateLeadStatusById(id, status);
  return { found: !!lead, lead };
}

function updateLeadNote(id, internalNote) {
  const lead = updateLeadNoteById(id, internalNote);
  return { found: !!lead, lead };
}

function deleteLeadById(id) {
  return { found: deleteLeadByIdRepo(id) };
}

function readBookings() {
  return findAllBookings();
}

function appendBooking(booking) {
  return insertBooking(booking);
}

function updateBookingStatus(id, status) {
  const booking = updateBookingStatusById(id, status);
  return { found: !!booking, booking };
}

function updateBookingNote(id, internalNote) {
  const booking = updateBookingNoteById(id, internalNote);
  return { found: !!booking, booking };
}

function deleteBookingById(id) {
  return { found: deleteBookingByIdRepo(id) };
}

function readVinChecks() {
  return findAllVinChecks();
}

function appendVinCheck(record) {
  return insertVinCheck(record);
}

// ---------------------------------------------------------------------------
// Admin auth — one shared password, checked via the x-admin-password header.
// ---------------------------------------------------------------------------

/** Constant-time string comparison so a wrong-password response can't be
 * timed to guess the real password character-by-character. */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // dummy compare so the failure path still takes ~constant time
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  const provided = req.get('x-admin-password') || '';
  if (!safeCompare(provided, ADMIN_PASSWORD)) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Invalid admin password' });
  }
  next();
}

function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** VIN check records store their generated numbers under `result`; CSV
 * export wants a flat row, so pull the relevant fields up to the top. */
function flattenVinCheckForCsv(record) {
  const result = record.result || {};
  return {
    id: record.id,
    createdAt: record.createdAt,
    status: record.status,
    vin: record.vin,
    score: result.score,
    riskLevel: result.riskLevel,
    year: result.year,
    estimatedMileage: result.estimatedMileage,
    advertisedMileage: result.advertisedMileage,
    accidents: result.accidents,
    owners: result.owners,
    odometerRisk: result.odometerRisk,
    language: record.language,
    source: record.source,
    paymentStatus: record.paymentStatus,
    paidAt: record.paidAt,
    paymentId: record.paymentId,
    internalNote: record.internalNote
  };
}

const CSV_COLUMNS = [
  'id', 'createdAt', 'type', 'status', 'companyName', 'contactName', 'email',
  'phone', 'city', 'vehiclesCount', 'qualification', 'availability',
  'language', 'source', 'message', 'internalNote'
];

const BOOKING_CSV_COLUMNS = [
  'id', 'createdAt', 'status', 'vin', 'listingUrl', 'city', 'preferredSlot',
  'contactName', 'email', 'phone', 'language', 'source', 'message', 'internalNote',
  'paidAt', 'paymentId'
];

const VIN_CHECK_CSV_COLUMNS = [
  'id', 'createdAt', 'status', 'vin', 'score', 'riskLevel', 'year',
  'estimatedMileage', 'advertisedMileage', 'accidents', 'owners',
  'odometerRisk', 'language', 'source', 'paymentStatus', 'paidAt', 'paymentId',
  'internalNote'
];

const EMAIL_LOG_CSV_COLUMNS = [
  'id', 'createdAt', 'entityType', 'entityId', 'recipientType',
  'recipientEmail', 'subject', 'status', 'errorMessage',
  'reviewedAt', 'resolvedAt', 'internalNote'
];

const PAYMENT_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'productCode', 'entityType', 'entityId',
  'status', 'amount', 'currency', 'provider', 'providerSessionId',
  'providerPaymentId', 'customerEmail', 'customerName', 'paidAt',
  'cancelledAt', 'failedAt', 'errorMessage', 'internalNote', 'expiredAt'
];

const REPORT_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'entityType', 'entityId', 'reportType',
  'status', 'title', 'customerEmail', 'riskLevel', 'score', 'verdict',
  'sentAt', 'completedAt', 'internalNote'
];

const AI_RUN_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'agentName', 'entityType', 'entityId',
  'status', 'provider', 'model', 'estimatedCost', 'requiresHumanReview',
  'reviewedAt', 'approvedAt', 'rejectedAt', 'reviewNote', 'errorMessage'
];

const AGENT_TASK_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'agentName', 'entityType', 'entityId',
  'taskType', 'title', 'status', 'suggestedAction', 'suggestedMessage',
  'reviewedAt', 'completedAt', 'description'
];

const INSPECTOR_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'name', 'email', 'phone', 'city',
  'qualification', 'active', 'internalNote'
];

const INSPECTION_JOB_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'bookingId', 'inspectorId', 'status',
  'scheduledAt', 'location', 'customerContact', 'completedAt', 'internalNote'
];

const DEALER_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'companyName', 'contactName', 'email',
  'phone', 'city', 'website', 'status', 'internalNote'
];

const DEALER_VEHICLE_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'dealerId', 'vin', 'make', 'model',
  'year', 'listingUrl', 'status'
];

const BADGE_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'dealerId', 'vehicleId', 'status',
  'badgeCode', 'issuedAt', 'expiresAt', 'revokedAt', 'internalNote'
];

const REVENUE_SHARE_LEDGER_CSV_COLUMNS = [
  'id', 'createdAt', 'paymentId', 'paymentAmount', 'currency', 'sharePercent',
  'shareAmount', 'paymentPaidAt', 'monthKey', 'status'
];

const MONTHLY_PAYOUT_CSV_COLUMNS = [
  'id', 'createdAt', 'updatedAt', 'monthKey', 'currency', 'grossRevenue',
  'sharePercent', 'shareAmount', 'status', 'payoutDueAt', 'payoutMethod',
  'payoutRecipientMasked', 'markedPaidAt', 'internalNote'
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

// ---------------------------------------------------------------------------
// Basic security headers — hand-rolled instead of pulling in `helmet` to
// keep the dependency footprint small; this covers the handful of headers
// that actually matter for a JSON API with no server-rendered HTML from
// user input. Applied to every response, including errors and 404s.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); // stops browsers guessing content-type on API responses
  res.setHeader('X-Frame-Options', 'DENY'); // this API is never meant to be framed
  res.setHeader('Referrer-Policy', 'no-referrer'); // no reason for admin URLs/ids to leak via Referer
  // HSTS only makes sense once this is actually served over HTTPS (e.g.
  // behind a reverse proxy that terminates TLS) — harmless to send always,
  // but it does nothing over plain HTTP, so don't treat its presence here
  // as "HTTPS is handled": see backend/README.md's production checklist.
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

app.use(cors({ origin: CORS_ALLOWED_ORIGINS }));

// ---------------------------------------------------------------------------
// POST /payments/webhook — registered BEFORE express.json() on purpose.
// Stripe's signature check needs the exact raw request bytes; once
// express.json() below has parsed the body, those bytes are gone. This
// route gets its own express.raw() middleware instead, scoped only to
// this one path — every other route still uses the normal JSON parser
// registered right after this.
// ---------------------------------------------------------------------------
app.post('/payments/webhook', express.raw({ type: '*/*', limit: '100kb' }), async (req, res, next) => {
  try {
    const provider = getPaymentProvider();

    if (provider.getProviderName() === 'stripe') {
      let event;
      try {
        event = provider.parseWebhookEvent(req); // verifies the signature and parses in one step
      } catch (err) {
        return res.status(400).json({ ok: false, error: 'INVALID_SIGNATURE', message: err.message });
      }
      if (!event) {
        // An event type we don't act on (Stripe still expects a 2xx so it
        // doesn't keep retrying).
        return res.json({ ok: true, ignored: true });
      }
      const { payment } = await applyWebhookEvent(event);
      return res.json({ ok: true, payment: { id: payment.id, status: payment.status } });
    }

    // Mock provider: req.body is a raw Buffer here (see express.raw()
    // above), so parse it ourselves as plain JSON test payload.
    let parsedBody;
    try {
      parsedBody = req.body && req.body.length ? JSON.parse(req.body.toString('utf-8')) : {};
    } catch {
      return res.status(400).json({ ok: false, error: 'INVALID_JSON', message: 'Request body is not valid JSON.' });
    }

    const { payment } = await handleMockWebhook(parsedBody);
    res.json({ ok: true, payment: { id: payment.id, status: payment.status } });
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: err.message });
    }
    if (err.code === 'INVALID_WEBHOOK_PAYLOAD' || err.code === 'UNKNOWN_EVENT_TYPE' || err.code === 'WRONG_PROVIDER') {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: err.message });
    }
    next(err);
  }
});

app.use(express.json({ limit: '100kb' })); // basic oversized-payload guard

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'nexium-backend', version: '0.1.0' });
});

app.post('/leads', rateLimit('leads'), async (req, res, next) => {
  try {
    const problems = validateLead(req.body);
    if (problems.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: problems.join(' ')
      });
    }

    const clean = sanitizeLead(req.body);
    const now = new Date().toISOString();
    const lead = {
      id: generateLeadId(),
      type: str(req.body.type),
      status: 'new',
      createdAt: now,
      updatedAt: now,
      ...clean
    };

    await appendLead(lead);

    // Email is best-effort and happens AFTER the lead is already saved.
    // Any failure here — bad SMTP config, a bug in a template, whatever —
    // must never turn a successful save into a failed response.
    let emailResult = { adminEmailSent: false, userEmailSent: false };
    try {
      emailResult = await sendLeadEmails(lead);
    } catch (err) {
      console.error('[email] sendLeadEmails failed unexpectedly:', err.message);
    }

    res.status(201).json({
      ok: true,
      id: lead.id,
      status: lead.status,
      type: lead.type,
      message: 'Lead saved successfully',
      email: {
        adminEmailSent: emailResult.adminEmailSent,
        userEmailSent: emailResult.userEmailSent
      }
    });
  } catch (err) {
    next(err);
  }
});

app.post('/bookings', rateLimit('bookings'), async (req, res, next) => {
  try {
    const problems = validateBooking(req.body);
    if (problems.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: problems.join(' ')
      });
    }

    const clean = sanitizeBooking(req.body);
    const now = new Date().toISOString();
    const booking = {
      id: generateBookingId(),
      status: 'new',
      createdAt: now,
      updatedAt: now,
      ...clean
    };

    await appendBooking(booking);

    let emailResult = { adminEmailSent: false, userEmailSent: false };
    try {
      emailResult = await sendBookingEmails(booking);
    } catch (err) {
      console.error('[email] sendBookingEmails failed unexpectedly:', err.message);
    }

    res.status(201).json({
      ok: true,
      id: booking.id,
      status: booking.status,
      message: 'Booking saved successfully',
      email: {
        adminEmailSent: emailResult.adminEmailSent,
        userEmailSent: emailResult.userEmailSent
      }
    });
  } catch (err) {
    next(err);
  }
});

app.post('/vin/check', rateLimit('vin-check'), async (req, res, next) => {
  try {
    const { problems, vin } = validateVinPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: problems.join(' ')
      });
    }

    const language = str(req.body.language) || 'unknown';
    const source = str(req.body.source) || 'vin_demo';
    const pageUrl = str(req.body.pageUrl);
    const createdAtClient = str(req.body.createdAtClient);

    const result = generateVinResult(vin);
    const now = new Date().toISOString();
    const record = {
      id: generateVinCheckId(),
      status: 'completed',
      createdAt: now,
      updatedAt: now,
      vin,
      language,
      source,
      pageUrl,
      createdAtClient,
      result,
      internalNote: ''
    };

    await appendVinCheck(record);

    let emailResult = { adminEmailSent: false, userEmailSent: false };
    try {
      emailResult = await sendVinCheckEmails(record);
    } catch (err) {
      console.error('[email] sendVinCheckEmails failed unexpectedly:', err.message);
    }

    res.status(201).json({
      ok: true,
      id: record.id,
      status: record.status,
      result,
      email: {
        adminEmailSent: emailResult.adminEmailSent,
        userEmailSent: emailResult.userEmailSent
      }
    });
  } catch (err) {
    next(err);
  }
});

app.post('/payments/checkout', rateLimit('payments-checkout'), async (req, res, next) => {
  try {
    const problems = validateCheckoutPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: problems.join(' ')
      });
    }

    const payment = await createCheckout(req.body);

    res.status(201).json({
      ok: true,
      payment: {
        id: payment.id,
        status: payment.status,
        productCode: payment.productCode,
        amount: payment.amount,
        currency: payment.currency,
        provider: payment.provider,
        checkoutUrl: payment.checkoutUrl
      }
    });
  } catch (err) {
    if (err.code === 'PAYMENTS_DISABLED') {
      return res.status(503).json({ ok: false, error: 'PAYMENTS_DISABLED', message: err.message });
    }
    if (err.code === 'PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: 'PROVIDER_NOT_CONFIGURED', message: err.message });
    }
    if (err.code === 'PROVIDER_ERROR') {
      // The payment provider (Stripe) itself rejected or failed the
      // request — already persisted as a `failed` payment row by
      // createCheckout()'s own catch block, this is just a clearer HTTP
      // response than a generic 500 for what's genuinely an upstream
      // failure, not a bug in this backend.
      return res.status(502).json({ ok: false, error: 'PROVIDER_ERROR', message: err.message });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin: leads management (list/detail/status/note/delete/CSV export).
// Every route below requires a valid x-admin-password header.
// ---------------------------------------------------------------------------

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

function filterLeads(leads, query) {
  let result = leads.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (query.type) result = result.filter((l) => l.type === query.type);
  if (query.status) result = result.filter((l) => l.status === query.status);
  if (query.search) {
    const q = String(query.search).trim().toLowerCase();
    result = result.filter((l) =>
      (l.email || '').toLowerCase().includes(q) ||
      (l.companyName || '').toLowerCase().includes(q) ||
      (l.contactName || '').toLowerCase().includes(q) ||
      (l.city || '').toLowerCase().includes(q)
    );
  }

  return result;
}

adminRouter.get('/leads', async (req, res, next) => {
  try {
    const leads = filterLeads(await readLeads(), req.query);

    const total = leads.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const items = leads.slice(offset, offset + limit);

    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /leads/:id on purpose — otherwise Express would match
// "export.csv" as an :id and this route would never be reached.
adminRouter.get('/leads/export.csv', async (req, res, next) => {
  try {
    const leads = filterLeads(await readLeads(), req.query);

    const rows = [CSV_COLUMNS.join(',')];
    for (const lead of leads) {
      rows.push(CSV_COLUMNS.map((col) => csvEscape(lead[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    // Leading BOM so Excel opens the CS/RU/UK diacritics correctly.
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/leads/:id', async (req, res, next) => {
  try {
    const leads = await readLeads();
    const lead = leads.find((l) => l.id === req.params.id);
    if (!lead) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lead not found.' });
    }
    res.json({ ok: true, item: lead });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/leads/:id/status', async (req, res, next) => {
  try {
    const status = str(req.body && req.body.status);
    if (!ADMIN_STATUSES.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: `status must be one of: ${ADMIN_STATUSES.join(', ')}`
      });
    }

    const result = await updateLeadStatus(req.params.id, status);
    if (!result.found) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lead not found.' });
    }
    res.json({ ok: true, item: result.lead });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/leads/:id/note', async (req, res, next) => {
  try {
    const internalNote = str(req.body && req.body.internalNote).slice(0, NOTE_MAX_LENGTH);
    const result = await updateLeadNote(req.params.id, internalNote);
    if (!result.found) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lead not found.' });
    }
    res.json({ ok: true, item: result.lead });
  } catch (err) {
    next(err);
  }
});

// Assigns (or unassigns, with assignedAgentId: null) a business agent to
// this lead — purely a bookkeeping field, doesn't affect status/emails/
// anything else.
adminRouter.patch('/leads/:id/assign', async (req, res, next) => {
  try {
    const problems = validateAssignPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const { assignedAgentId } = req.body;
    if (assignedAgentId !== null && !agentExists(assignedAgentId)) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `Unknown assignedAgentId "${assignedAgentId}".` });
    }

    const updated = updateLeadAssignedAgentById(req.params.id, assignedAgentId);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lead not found.' });
    }
    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/leads/:id', async (req, res, next) => {
  try {
    const result = await deleteLeadById(req.params.id);
    if (!result.found) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lead not found.' });
    }
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminRouter);

// ---------------------------------------------------------------------------
// Admin: bookings management. Same shape as the leads admin router above,
// mounted separately so it can never interfere with /admin/leads/*.
// ---------------------------------------------------------------------------

const adminBookingsRouter = express.Router();
adminBookingsRouter.use(requireAdmin);

function filterBookings(bookings, query) {
  let result = bookings.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (query.status) result = result.filter((b) => b.status === query.status);
  if (query.city) result = result.filter((b) => (b.city || '').toLowerCase() === String(query.city).toLowerCase());
  if (query.search) {
    const q = String(query.search).trim().toLowerCase();
    result = result.filter((b) =>
      (b.vin || '').toLowerCase().includes(q) ||
      (b.email || '').toLowerCase().includes(q) ||
      (b.phone || '').toLowerCase().includes(q) ||
      (b.contactName || '').toLowerCase().includes(q) ||
      (b.city || '').toLowerCase().includes(q)
    );
  }

  return result;
}

adminBookingsRouter.get('/bookings', async (req, res, next) => {
  try {
    const bookings = filterBookings(await readBookings(), req.query);

    const total = bookings.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const items = bookings.slice(offset, offset + limit);

    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /bookings/:id on purpose — same Express routing gotcha
// as /admin/leads/export.csv above.
adminBookingsRouter.get('/bookings/export.csv', async (req, res, next) => {
  try {
    const bookings = filterBookings(await readBookings(), req.query);

    const rows = [BOOKING_CSV_COLUMNS.join(',')];
    for (const booking of bookings) {
      rows.push(BOOKING_CSV_COLUMNS.map((col) => csvEscape(booking[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookings-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminBookingsRouter.get('/bookings/:id', async (req, res, next) => {
  try {
    const bookings = await readBookings();
    const booking = bookings.find((b) => b.id === req.params.id);
    if (!booking) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Booking not found.' });
    }
    res.json({ ok: true, item: booking });
  } catch (err) {
    next(err);
  }
});

adminBookingsRouter.patch('/bookings/:id/status', async (req, res, next) => {
  try {
    const status = str(req.body && req.body.status);
    if (!ADMIN_BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: `status must be one of: ${ADMIN_BOOKING_STATUSES.join(', ')}`
      });
    }

    const result = await updateBookingStatus(req.params.id, status);
    if (!result.found) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Booking not found.' });
    }
    res.json({ ok: true, item: result.booking });
  } catch (err) {
    next(err);
  }
});

adminBookingsRouter.patch('/bookings/:id/note', async (req, res, next) => {
  try {
    const internalNote = str(req.body && req.body.internalNote).slice(0, NOTE_MAX_LENGTH);
    const result = await updateBookingNote(req.params.id, internalNote);
    if (!result.found) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Booking not found.' });
    }
    res.json({ ok: true, item: result.booking });
  } catch (err) {
    next(err);
  }
});

adminBookingsRouter.patch('/bookings/:id/assign', async (req, res, next) => {
  try {
    const problems = validateAssignPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const { assignedAgentId } = req.body;
    if (assignedAgentId !== null && !agentExists(assignedAgentId)) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `Unknown assignedAgentId "${assignedAgentId}".` });
    }

    const updated = updateBookingAssignedAgentById(req.params.id, assignedAgentId);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Booking not found.' });
    }
    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

adminBookingsRouter.delete('/bookings/:id', async (req, res, next) => {
  try {
    const result = await deleteBookingById(req.params.id);
    if (!result.found) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Booking not found.' });
    }
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

/**
 * Creates the inspection job for a paid booking — the ONLY way an
 * inspection_jobs row comes into existence (see
 * backend/README.md's "Inspector workflow" section). Enforces two
 * things server-side, not just in the UI:
 *   - the booking must be status="paid" (never create a job — or
 *     implicitly signal "go schedule someone" — for a booking nobody
 *     has actually paid for);
 *   - at most ONE job per booking (idempotent — calling this again on a
 *     booking that already has a job returns 400 with the existing
 *     job's id, never a silent duplicate).
 * On success, also advances the booking's own status from "paid" to
 * "inspector_needed" — reusing the status vocabulary
 * ADMIN_BOOKING_STATUSES already had (inspector_needed/
 * inspector_assigned/inspection_scheduled were already in that list and
 * already in admin-bookings.html's own status dropdowns before this
 * step — this wires them up, it doesn't invent them).
 */
adminBookingsRouter.post('/bookings/:id/inspection-job', async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Booking not found.' });
    }

    // Checked BEFORE the paid-status check on purpose: once a job
    // exists, this booking's own status typically already advanced past
    // "paid" (see advanceBookingStatusIfBehind() below) — checking
    // existence first means a repeat call always gets the precise
    // "already has a job" answer instead of a generic status complaint.
    const existingJob = getInspectionJobByBookingId(booking.id);
    if (existingJob) {
      return res.status(400).json({ ok: false, error: 'ALREADY_EXISTS', message: `This booking already has an inspection job (${existingJob.id}).`, inspectionJobId: existingJob.id });
    }

    if (booking.status !== 'paid') {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `Booking status is "${booking.status}", not "paid" — an inspection job can only be created for a paid booking.` });
    }

    const problems = validateCreateInspectionJobPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const customerContact = [booking.contactName, booking.phone].filter(Boolean).join(' · ') || null;
    const job = createInspectionJob({
      bookingId: booking.id,
      inspectorId: (req.body && req.body.inspectorId) || null,
      location: booking.city || null,
      customerContact
    });

    updateBookingStatusById(booking.id, 'inspector_needed');

    res.status(201).json({ ok: true, job });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminBookingsRouter);

// ---------------------------------------------------------------------------
// Admin: VIN checks — read-only for now (list/detail/CSV export only, no
// PATCH/DELETE yet, on purpose). Mounted separately, same isolation
// principle as the leads/bookings admin routers.
// ---------------------------------------------------------------------------

const adminVinChecksRouter = express.Router();
adminVinChecksRouter.use(requireAdmin);

function filterVinChecks(records, query) {
  let result = records.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (query.riskLevel) result = result.filter((r) => r.result && r.result.riskLevel === query.riskLevel);
  if (query.search) {
    const q = String(query.search).trim().toLowerCase();
    result = result.filter((r) =>
      (r.vin || '').toLowerCase().includes(q) ||
      (r.id || '').toLowerCase().includes(q) ||
      (r.source || '').toLowerCase().includes(q) ||
      (r.language || '').toLowerCase().includes(q)
    );
  }

  return result;
}

adminVinChecksRouter.get('/vin-checks', async (req, res, next) => {
  try {
    const records = filterVinChecks(await readVinChecks(), req.query);

    const total = records.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const items = records.slice(offset, offset + limit);

    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /vin-checks/:id on purpose — same Express routing
// gotcha as the other export.csv routes above.
adminVinChecksRouter.get('/vin-checks/export.csv', async (req, res, next) => {
  try {
    const records = filterVinChecks(await readVinChecks(), req.query);

    const rows = [VIN_CHECK_CSV_COLUMNS.join(',')];
    for (const record of records) {
      const flat = flattenVinCheckForCsv(record);
      rows.push(VIN_CHECK_CSV_COLUMNS.map((col) => csvEscape(flat[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vin-checks-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminVinChecksRouter.get('/vin-checks/:id', async (req, res, next) => {
  try {
    const records = await readVinChecks();
    const record = records.find((r) => r.id === req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'VIN check not found.' });
    }
    // Lets the admin UI show/hide and label the "Run VIN provider"
    // button correctly without guessing — this is the backend's own
    // current VIN_PROVIDER value, not sensitive, admin-only anyway.
    res.json({ ok: true, item: record, vinProviderMode: VIN_PROVIDER_NAME });
  } catch (err) {
    next(err);
  }
});

// Admin-only free-text note. Deliberately no status PATCH or DELETE for
// VIN checks — this step adds only the note, on purpose (see this step's
// scope). Response uses `vinCheck` (not `item`) to match the spec for
// this endpoint exactly; the record shape itself is identical to what
// GET /admin/vin-checks/:id already returns.
adminVinChecksRouter.patch('/vin-checks/:id/note', async (req, res, next) => {
  try {
    const problems = validateVinCheckNotePayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: problems.join(' ')
      });
    }

    const updated = updateVinCheckNoteById(req.params.id, req.body.internalNote);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'VIN check not found.' });
    }

    res.json({ ok: true, vinCheck: updated });
  } catch (err) {
    next(err);
  }
});

adminVinChecksRouter.patch('/vin-checks/:id/assign', async (req, res, next) => {
  try {
    const problems = validateAssignPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const { assignedAgentId } = req.body;
    if (assignedAgentId !== null && !agentExists(assignedAgentId)) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `Unknown assignedAgentId "${assignedAgentId}".` });
    }

    const updated = updateVinCheckAssignedAgentById(req.params.id, assignedAgentId);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'VIN check not found.' });
    }
    res.json({ ok: true, vinCheck: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Real VIN provider — admin-triggered only, never from the public
// POST /vin/check form (see backend/vin/demoVinProvider.js's own comment
// for why). See backend/README.md's "Real VIN provider adapter" section
// for the full picture: money-safety default (paid-only), honest
// unverified status, ToS/legal notes.
// ---------------------------------------------------------------------------

// Rate-limited even though it's admin-only — this is the one endpoint
// in the whole backend that can trigger a real, possibly-billed
// external API call (see backend/vin/realVinProviderAdapter.js).
// requireAdmin + the paid-only gate already stop it from running for
// free/against the wrong data, but neither stops an admin session
// (compromised, or just a fast double-click) from firing it rapidly
// against many different paid vin_checks in a row — this caps that,
// same rate as the AI run endpoint. Found during the production launch
// audit — this endpoint was the one write route without any rate limit.
adminVinChecksRouter.post('/vin-checks/:id/run-provider', rateLimit('vin-run-provider'), async (req, res, next) => {
  try {
    const records = await readVinChecks();
    const record = records.find((r) => r.id === req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'VIN check not found.' });
    }

    if (VIN_PROVIDER_NAME === 'demo') {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: 'VIN_PROVIDER=demo — there is no real provider to run. This endpoint is for VIN_PROVIDER=real or mock_real; the demo result was already generated when this VIN check was created.'
      });
    }

    if (VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK && record.paymentStatus !== 'paid') {
      return res.status(400).json({
        ok: false,
        error: 'PAYMENT_REQUIRED',
        message: `This VIN check's paymentStatus is "${record.paymentStatus || 'none'}", not "paid" — VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK=true blocks real provider calls (which may cost real money) against unpaid checks.`
      });
    }

    const run = await runVinProviderCheck({ vinCheckId: record.id, vin: record.vin });
    res.status(201).json({ ok: true, run });
  } catch (err) {
    if (err.code === 'PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: 'PROVIDER_NOT_CONFIGURED', message: err.message });
    }
    if (err.code === 'PROVIDER_ERROR') {
      return res.status(502).json({ ok: false, error: 'PROVIDER_ERROR', message: err.message });
    }
    next(err);
  }
});

adminVinChecksRouter.get('/vin-checks/:id/provider-runs', async (req, res, next) => {
  try {
    const records = await readVinChecks();
    const record = records.find((r) => r.id === req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'VIN check not found.' });
    }
    const items = listVinProviderRunsForVinCheck(record.id);
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminVinChecksRouter);

// ---------------------------------------------------------------------------
// Admin: email logs — read-only visibility into what sendLeadEmails() /
// sendBookingEmails() / sendVinCheckEmails() actually attempted, plus a
// manual admin review state (reviewed/resolved/internalNote — see
// updateReviewState() in the repository for exactly what that means).
// admin-email-logs.html is the UI for this.
// ---------------------------------------------------------------------------

function filterEmailLogs(logs, query) {
  let result = logs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (query.entityType) result = result.filter((l) => l.entityType === query.entityType);
  if (query.entityId) result = result.filter((l) => l.entityId === query.entityId);
  if (query.status) result = result.filter((l) => l.status === query.status);
  if (query.reviewed === 'true') result = result.filter((l) => !!l.reviewedAt);
  if (query.reviewed === 'false') result = result.filter((l) => !l.reviewedAt);
  if (query.resolved === 'true') result = result.filter((l) => !!l.resolvedAt);
  if (query.resolved === 'false') result = result.filter((l) => !l.resolvedAt);
  if (query.search) {
    const q = String(query.search).trim().toLowerCase();
    result = result.filter((l) =>
      (l.recipientEmail || '').toLowerCase().includes(q) ||
      (l.subject || '').toLowerCase().includes(q) ||
      (l.errorMessage || '').toLowerCase().includes(q) ||
      (l.entityId || '').toLowerCase().includes(q)
    );
  }

  return result;
}

app.get('/admin/email-logs', requireAdmin, async (req, res, next) => {
  try {
    const logs = filterEmailLogs(findAllEmailLogs(), req.query);

    const total = logs.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const items = logs.slice(offset, offset + limit);

    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

// Same filters as the list endpoint above, via filterEmailLogs(). No :id
// route exists for email logs' GET, so there's no Express routing-order
// gotcha to worry about here (unlike the other three export.csv routes) —
// but PATCH .../review below IS a distinct path, registered separately.
app.get('/admin/email-logs/export.csv', requireAdmin, async (req, res, next) => {
  try {
    const logs = filterEmailLogs(findAllEmailLogs(), req.query);

    const rows = [EMAIL_LOG_CSV_COLUMNS.join(',')];
    for (const log of logs) {
      rows.push(EMAIL_LOG_CSV_COLUMNS.map((col) => csvEscape(log[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="email-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    // Leading BOM so Excel opens CS/RU/UK diacritics in subjects correctly.
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

// Registered AFTER export.csv on purpose — otherwise Express would match
// "export.csv" itself as an :id value (same gotcha noted on the other
// four admin routers). Added so admin-email-logs.js can confirm its
// detail view against the server on open, matching the other four pages.
app.get('/admin/email-logs/:id', requireAdmin, async (req, res, next) => {
  try {
    const log = findAllEmailLogs().find((l) => l.id === req.params.id);
    if (!log) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Email log not found.' });
    }
    res.json({ ok: true, item: log });
  } catch (err) {
    next(err);
  }
});

// Manual admin review state — status (sent/failed/skipped) stays the
// factual send outcome and is never touched here; this is purely "has an
// admin looked at this yet / dealt with it" bookkeeping.
app.patch('/admin/email-logs/:id/review', requireAdmin, async (req, res, next) => {
  try {
    const problems = validateEmailLogReviewPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: problems.join(' ')
      });
    }

    const updated = updateReviewState(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Email log not found.' });
    }

    res.json({ ok: true, emailLog: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin: payments — read-only, same isolation principle as the other admin
// routers (no PATCH/DELETE on this step, on purpose — payment records are
// a financial audit trail, not something to hand-edit from a UI).
// admin-payments.html is the UI for this.
// ---------------------------------------------------------------------------

function filterPayments(payments, query) {
  let result = payments.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (query.status) result = result.filter((p) => p.status === query.status);
  if (query.productCode) result = result.filter((p) => p.productCode === query.productCode);
  if (query.entityType) result = result.filter((p) => p.entityType === query.entityType);
  if (query.entityId) result = result.filter((p) => p.entityId === query.entityId);
  if (query.customerEmail) {
    const q = String(query.customerEmail).trim().toLowerCase();
    result = result.filter((p) => (p.customerEmail || '').toLowerCase() === q);
  }
  if (query.search) {
    const q = String(query.search).trim().toLowerCase();
    result = result.filter((p) =>
      (p.customerEmail || '').toLowerCase().includes(q) ||
      (p.customerName || '').toLowerCase().includes(q) ||
      (p.entityId || '').toLowerCase().includes(q) ||
      (p.providerSessionId || '').toLowerCase().includes(q) ||
      (p.providerPaymentId || '').toLowerCase().includes(q) ||
      (p.id || '').toLowerCase().includes(q)
    );
  }

  return result;
}

app.get('/admin/payments', requireAdmin, async (req, res, next) => {
  try {
    const payments = filterPayments(findAllPayments(), req.query);

    const total = payments.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const items = payments.slice(offset, offset + limit);

    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /payments/:id on purpose — same Express routing
// gotcha as the other export.csv routes above.
app.get('/admin/payments/export.csv', requireAdmin, async (req, res, next) => {
  try {
    const payments = filterPayments(findAllPayments(), req.query);

    const rows = [PAYMENT_CSV_COLUMNS.join(',')];
    for (const payment of payments) {
      rows.push(PAYMENT_CSV_COLUMNS.map((col) => csvEscape(payment[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

app.get('/admin/payments/:id', requireAdmin, async (req, res, next) => {
  try {
    const payment = findPaymentById(req.params.id);
    if (!payment) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Payment not found.' });
    }
    res.json({ ok: true, item: payment });
  } catch (err) {
    next(err);
  }
});

// Admin-only free-text note. Purely an annotation — never touches status,
// paidAt, or any payment-linking/idempotency field. Response uses
// `payment` (not `item`) to match this endpoint's own spec exactly.
app.patch('/admin/payments/:id/note', requireAdmin, async (req, res, next) => {
  try {
    const problems = validatePaymentNotePayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: problems.join(' ')
      });
    }

    const updated = updatePaymentNote(req.params.id, req.body.internalNote);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Payment not found.' });
    }

    res.json({ ok: true, payment: updated });
  } catch (err) {
    next(err);
  }
});

app.patch('/admin/payments/:id/assign', requireAdmin, async (req, res, next) => {
  try {
    const problems = validateAssignPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const { assignedAgentId } = req.body;
    if (assignedAgentId !== null && !agentExists(assignedAgentId)) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `Unknown assignedAgentId "${assignedAgentId}".` });
    }

    const updated = updatePaymentAssignedAgent(req.params.id, assignedAgentId);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Payment not found.' });
    }
    res.json({ ok: true, payment: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin: agents — the staff/role directory that leads/bookings/vin-checks/
// payments can be assigned to. Deliberately still gated by the single
// shared ADMIN_PASSWORD, same as everything else — this is a business-data
// CRUD, not a login/session system (see backend/README.md "Агенты" for
// what that means and what it doesn't).
// ---------------------------------------------------------------------------

const adminAgentsRouter = express.Router();
adminAgentsRouter.use(requireAdmin);

function filterAgents(agents, query) {
  let result = agents.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (query.role) result = result.filter((a) => a.role === query.role);
  if (query.active === 'true') result = result.filter((a) => a.active === true);
  if (query.active === 'false') result = result.filter((a) => a.active === false);
  if (query.search) {
    const q = String(query.search).trim().toLowerCase();
    result = result.filter((a) =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.email || '').toLowerCase().includes(q)
    );
  }

  return result;
}

adminAgentsRouter.get('/agents', async (req, res, next) => {
  try {
    const agents = filterAgents(findAllAgents(), req.query);

    const total = agents.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const items = agents.slice(offset, offset + limit);

    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

adminAgentsRouter.get('/agents/:id', async (req, res, next) => {
  try {
    const agent = findAgentById(req.params.id);
    if (!agent) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Agent not found.' });
    }
    res.json({ ok: true, item: agent });
  } catch (err) {
    next(err);
  }
});

adminAgentsRouter.post('/agents', async (req, res, next) => {
  try {
    const problems = validateCreateAgentPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const now = new Date().toISOString();
    const agent = {
      id: 'agent_' + crypto.randomBytes(6).toString('hex'),
      name: str(req.body.name),
      role: str(req.body.role),
      email: str(req.body.email) || null,
      active: req.body.active !== undefined ? req.body.active : true,
      createdAt: now,
      updatedAt: now
    };

    insertAgent(agent);
    res.status(201).json({ ok: true, agent: findAgentById(agent.id) });
  } catch (err) {
    next(err);
  }
});

// General update — name/role/email/active all optional, any subset.
// "Deactivate" is just active:false through this same endpoint (soft —
// there's no DELETE for agents, on purpose: an inactive agent's history
// of past assignments stays intact and readable).
adminAgentsRouter.patch('/agents/:id', async (req, res, next) => {
  try {
    const problems = validateUpdateAgentPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const patch = {};
    if (req.body.name !== undefined) patch.name = str(req.body.name);
    if (req.body.role !== undefined) patch.role = str(req.body.role);
    if (req.body.email !== undefined) patch.email = str(req.body.email) || null;
    if (req.body.active !== undefined) patch.active = req.body.active;

    const updated = updateAgentById(req.params.id, patch);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Agent not found.' });
    }
    res.json({ ok: true, agent: updated });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminAgentsRouter);

// ---------------------------------------------------------------------------
// Admin: reports — the operational workflow for paid VIN-check / manual-
// review orders (created -> in_review -> draft_ready -> report_ready ->
// report_sent -> completed, or cancelled at any point). Auto-created by
// paymentService.js's createForPaidPayment() when a matching payment
// clears (see that file) — no public POST endpoint here on purpose, per
// this step's scope (report delivery to the customer is a later step).
// ---------------------------------------------------------------------------

const adminReportsRouter = express.Router();
adminReportsRouter.use(requireAdmin);

/** Never send the full publicToken in the bulk list response — only a
 * short, non-reusable preview (first 8 hex chars + "…"), so glancing at
 * admin-reports.html's table (or a screenshot of it) can't leak a
 * working link. The full token is only ever returned from GET
 * /admin/reports/:id — a single, deliberate lookup, not a bulk view. */
function maskReportForList(report) {
  const { publicToken, ...rest } = report;
  return {
    ...rest,
    publicTokenPreview: publicToken ? `${publicToken.slice(0, 8)}…` : null
  };
}

adminReportsRouter.get('/reports', async (req, res, next) => {
  try {
    const { items, total } = listReports(req.query);
    res.json({ ok: true, items: items.map(maskReportForList), total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /reports/:id on purpose — otherwise Express would
// match "export.csv" itself as an :id value (same gotcha as every other
// admin router in this file).
adminReportsRouter.get('/reports/export.csv', async (req, res, next) => {
  try {
    const reports = listAllMatchingReports(req.query);

    const rows = [REPORT_CSV_COLUMNS.join(',')];
    for (const report of reports) {
      rows.push(REPORT_CSV_COLUMNS.map((col) => csvEscape(report[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reports-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminReportsRouter.get('/reports/:id', async (req, res, next) => {
  try {
    const report = getReportById(req.params.id);
    if (!report) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    // Computed, not stored — same APP_URL the customer email itself uses
    // (see sendReportReadyEmail), so the admin's "Copy link" button and
    // the actual emailed link are always identical. null if no token
    // has ever been generated for this report yet.
    const publicLink = report.publicToken ? `${APP_URL}/report.html?token=${report.publicToken}` : null;
    res.json({ ok: true, item: { ...report, publicLink } });
  } catch (err) {
    next(err);
  }
});

adminReportsRouter.get('/reports/:id/history', async (req, res, next) => {
  try {
    if (!getReportById(req.params.id)) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    const items = listStatusHistory(req.params.id);
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

adminReportsRouter.patch('/reports/:id/status', async (req, res, next) => {
  try {
    const problems = validateReportStatusPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    if (!getReportById(req.params.id)) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }

    const transitionProblems = validateReportStatusTransition(req.params.id, req.body.status);
    if (transitionProblems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: transitionProblems.join(' ') });
    }

    const updated = updateReportStatus(req.params.id, req.body.status, str(req.body.reason) || null);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    res.json({ ok: true, report: updated });
  } catch (err) {
    next(err);
  }
});

adminReportsRouter.patch('/reports/:id/note', async (req, res, next) => {
  try {
    const problems = validateReportNotePayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const updated = updateReportNote(req.params.id, req.body.internalNote);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    res.json({ ok: true, report: updated });
  } catch (err) {
    next(err);
  }
});

adminReportsRouter.patch('/reports/:id/summary', async (req, res, next) => {
  try {
    const problems = validateReportSummaryPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const updated = updateReportSummary(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    res.json({ ok: true, report: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Report sections — the manual report builder. A report's sections are
// auto-created (see reportsRepository.js's createReport()) when the
// report itself is created; nothing here creates a report or a section
// from scratch on its own, only edits/reorders/resets what already
// exists.
// ---------------------------------------------------------------------------

adminReportsRouter.get('/reports/:id/sections', async (req, res, next) => {
  try {
    if (!getReportById(req.params.id)) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    const items = listSections(req.params.id);
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

// Deliberately a separate top-level path (not nested under /reports/:id)
// — a section is edited by its own id, the same way /admin/payments/:id
// or /admin/leads/:id work, not by (reportId, sectionKey) together.
adminReportsRouter.patch('/report-sections/:sectionId', async (req, res, next) => {
  try {
    const problems = validateReportSectionPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const existing = getSection(req.params.sectionId);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report section not found.' });
    }

    const updated = updateSection(req.params.sectionId, req.body);
    // A saved section always bumps the parent report's updatedAt, even
    // though no field on the report row itself changed — best-effort,
    // never blocks the section save if it somehow fails.
    try {
      touchReport(existing.reportId);
    } catch (err) {
      console.error('[reports] touchReport failed unexpectedly:', err.message);
    }

    res.json({ ok: true, section: updated });
  } catch (err) {
    next(err);
  }
});

adminReportsRouter.patch('/reports/:id/sections/reorder', async (req, res, next) => {
  try {
    if (!getReportById(req.params.id)) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }

    const problems = validateReorderPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const existingSections = listSections(req.params.id);
    const existingIds = new Set(existingSections.map((s) => s.id));
    const orderedIds = req.body.orderedIds;

    // Every id must belong to this report, and the reorder must cover
    // every section this report currently has — a partial list would
    // leave some sections with a stale sortOrder relative to the ones
    // that did get reordered, which is worse than just rejecting it.
    const unknownIds = orderedIds.filter((id) => !existingIds.has(id));
    if (unknownIds.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `orderedIds contains ids that don't belong to this report: ${unknownIds.join(', ')}.` });
    }
    if (orderedIds.length !== existingSections.length || new Set(orderedIds).size !== existingSections.length) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `orderedIds must contain each of this report's ${existingSections.length} section ids exactly once.` });
    }

    const items = reorderSections(req.params.id, orderedIds);
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

adminReportsRouter.post('/reports/:id/sections/reset-defaults', async (req, res, next) => {
  try {
    const report = getReportById(req.params.id);
    if (!report) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }

    const items = resetDefaultSections(req.params.id, report.reportType);
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

// Admin-only preview of the report's current content — separate from the
// PUBLIC GET /reports/public/:token below (different route, different
// auth, different response shape: this one includes admin-only fields,
// that one deliberately doesn't). Same requireAdmin gate as everything
// else on this router.
adminReportsRouter.get('/reports/:id/preview', async (req, res, next) => {
  try {
    const report = getReportById(req.params.id);
    if (!report) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    const sections = listSections(req.params.id);
    res.json({ ok: true, report, sections });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Public report delivery — a private, unguessable link the customer can
// open without any password. See the public GET /reports/public/:token
// route further down (registered directly on `app`, NOT this admin
// router, since it must never require x-admin-password).
// ---------------------------------------------------------------------------

adminReportsRouter.post('/reports/:id/public-token', async (req, res, next) => {
  try {
    const updated = generatePublicToken(req.params.id);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    res.status(201).json({ ok: true, report: updated, publicLink: `${APP_URL}/report.html?token=${updated.publicToken}` });
  } catch (err) {
    next(err);
  }
});

adminReportsRouter.delete('/reports/:id/public-token', async (req, res, next) => {
  try {
    if (!getReportById(req.params.id)) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    const updated = revokePublicToken(req.params.id);
    res.json({ ok: true, report: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * Generates/ensures a working public token, emails the customer a link to
 * it, and — ONLY if that email genuinely sent — transitions the report
 * to report_sent and stamps sentAt/deliveredAt. If EMAIL_ENABLED=false
 * (or SMTP fails), the token/link are still created and returned so the
 * admin can share it manually, but the status is deliberately left alone
 * — "sent" should mean the email really went out, not just that this
 * endpoint was called. The response always tells the caller which
 * happened (`emailSent: true/false`), so this isn't a silent partial
 * success.
 */
adminReportsRouter.post('/reports/:id/send-to-customer', async (req, res, next) => {
  try {
    const report = getReportById(req.params.id);
    if (!report) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    if (report.status !== 'report_ready') {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `Report must be report_ready to send — current status is "${report.status}".` });
    }
    if (!str(report.customerEmail)) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: 'Report has no customerEmail to send to.' });
    }

    // Reuse an existing, still-valid token if there is one — only
    // generate a fresh one if none exists yet, or the existing one was
    // revoked (sending a link that 410s immediately would be worse than
    // just minting a new one).
    let current = report;
    if (!current.publicToken || current.publicTokenRevokedAt) {
      current = generatePublicToken(req.params.id);
    }
    const publicLink = `${APP_URL}/report.html?token=${current.publicToken}`;

    const emailResult = await sendReportReadyEmail(current, publicLink);

    let finalReport = current;
    if (emailResult.userEmailSent) {
      finalReport = updateReportStatus(req.params.id, 'report_sent', 'Sent to customer by email.');
      markDelivered(req.params.id);
      finalReport = getReportById(req.params.id);
    }

    res.json({
      ok: true,
      report: finalReport,
      publicLink,
      emailSent: emailResult.userEmailSent,
      message: emailResult.userEmailSent
        ? 'Email sent — report marked as report_sent.'
        : 'Email was not sent (EMAIL_ENABLED=false or SMTP failure) — link is ready, share it manually. Status was NOT changed to report_sent.'
    });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminReportsRouter);

// ---------------------------------------------------------------------------
// Admin: AI orchestrator foundation — see backend/README.md's "AI
// orchestrator foundation" section for the full picture. Short version:
// every run requires human review before its output is used anywhere
// else, AI_ENABLED=false by default, and only the mock provider actually
// runs in this step (see backend/ai/aiClient.js).
// ---------------------------------------------------------------------------

const adminAiRouter = express.Router();
adminAiRouter.use(requireAdmin);

adminAiRouter.post('/ai/run', rateLimit('ai-run'), async (req, res, next) => {
  try {
    const problems = validateRunRequest(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const run = await runAgent({
      agentName: str(req.body.agentName),
      entityType: str(req.body.entityType),
      entityId: str(req.body.entityId),
      input: req.body.input
    });

    res.status(201).json({ ok: true, run, disclaimer: AI_OUTPUT_DISCLAIMER });
  } catch (err) {
    if (err.code === 'AI_DISABLED') {
      return res.status(503).json({ ok: false, error: 'AI_DISABLED', message: err.message });
    }
    if (err.code === 'PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: 'PROVIDER_NOT_CONFIGURED', message: err.message });
    }
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: err.message });
    }
    next(err);
  }
});

adminAiRouter.get('/ai/runs', async (req, res, next) => {
  try {
    const { items, total } = listAiRuns(req.query);
    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /ai/runs/:id on purpose — otherwise Express would
// match "export.csv" itself as an :id value (same gotcha as every other
// admin router in this file).
adminAiRouter.get('/ai/runs/export.csv', async (req, res, next) => {
  try {
    const runs = listAllMatchingAiRuns(req.query);

    const rows = [AI_RUN_CSV_COLUMNS.join(',')];
    for (const run of runs) {
      rows.push(AI_RUN_CSV_COLUMNS.map((col) => csvEscape(run[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';

    // inputJson/outputJson deliberately excluded from CSV — can be up to
    // AI_MAX_INPUT_CHARS long plus the model's own output text, which
    // makes for an unreadable spreadsheet cell; view them in
    // admin-ai-runs.html's detail panel instead.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-runs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminAiRouter.get('/ai/runs/:id', async (req, res, next) => {
  try {
    const run = getAiRunById(req.params.id);
    if (!run) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'AI run not found.' });
    }
    res.json({ ok: true, item: run, disclaimer: AI_OUTPUT_DISCLAIMER });
  } catch (err) {
    next(err);
  }
});

adminAiRouter.patch('/ai/runs/:id/review', async (req, res, next) => {
  try {
    const problems = validateAiReviewPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const existing = getAiRunById(req.params.id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'AI run not found.' });
    }

    const updated = updateAiRunReview(req.params.id, {
      approved: req.body.approved,
      reviewNote: req.body.reviewNote !== undefined ? req.body.reviewNote : undefined
    });
    res.json({ ok: true, run: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * The ONLY endpoint that can move AI output into a report's actual
 * content (report_sections / reports.score / reports.riskLevel /
 * reports.summary / reports.verdict — see backend/ai/applyToReport.js
 * for the exact per-agent mapping). Refuses anything that isn't a
 * completed, APPROVED run — never a rejected run, never a run still
 * awaiting review, regardless of what the request asks for. This is the
 * enforcement point for "human review before anything reaches a
 * report" — applyToReport.js itself trusts that this check already
 * happened and doesn't repeat it.
 */
adminAiRouter.post('/ai/runs/:id/apply', async (req, res, next) => {
  try {
    const run = getAiRunById(req.params.id);
    if (!run) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'AI run not found.' });
    }
    if (run.status !== 'completed') {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `Run status is "${run.status}" — only a completed run can be applied.` });
    }
    if (!run.approvedAt) {
      return res.status(400).json({ ok: false, error: 'NOT_APPROVED', message: 'This run has not been approved yet — reject or approve it in review before applying.' });
    }

    let results;
    try {
      results = applyRunToReport(run);
    } catch (applyErr) {
      return res.status(400).json({ ok: false, error: 'APPLY_FAILED', message: applyErr.message });
    }

    const updatedRun = markAiRunApplied(run.id);
    res.json({ ok: true, run: updatedRun, results });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Wave 2 — business agents (CRM Follow-up / B2B Sales / Support /
// Operations-Payment Assistant). These NEVER send anything, change any
// entity's status, or delete data — they only ever produce agent_tasks
// rows: suggestions for a human admin to review, edit, and act on
// themselves. See backend/ai/businessAgentRunner.js for the full
// enforcement, and backend/README.md's "AI agents — wave 2" section for
// the complete picture.
// ---------------------------------------------------------------------------

adminAiRouter.post('/agents/run-business-agent', rateLimit('ai-run'), async (req, res, next) => {
  try {
    const problems = validateBusinessRunRequest(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const tasks = await runBusinessAgent({
      agentName: str(req.body.agentName),
      entityType: str(req.body.entityType),
      entityId: str(req.body.entityId),
      input: req.body.input
    });

    res.status(201).json({ ok: true, tasks, disclaimer: AI_OUTPUT_DISCLAIMER });
  } catch (err) {
    if (err.code === 'AI_DISABLED') {
      return res.status(503).json({ ok: false, error: 'AI_DISABLED', message: err.message });
    }
    if (err.code === 'PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: 'PROVIDER_NOT_CONFIGURED', message: err.message });
    }
    if (err.code === 'VALIDATION_ERROR' || err.code === 'INVALID_OUTPUT') {
      return res.status(400).json({ ok: false, error: err.code, message: err.message });
    }
    next(err);
  }
});

adminAiRouter.get('/agent-tasks', async (req, res, next) => {
  try {
    const { items, total } = listAgentTasks(req.query);
    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /agent-tasks/:id on purpose — otherwise Express
// would match "export.csv" itself as an :id value (same gotcha as every
// other admin router in this file).
adminAiRouter.get('/agent-tasks/export.csv', async (req, res, next) => {
  try {
    const tasks = listAllMatchingAgentTasks(req.query);

    const rows = [AGENT_TASK_CSV_COLUMNS.join(',')];
    for (const task of tasks) {
      rows.push(AGENT_TASK_CSV_COLUMNS.map((col) => csvEscape(task[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agent-tasks-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminAiRouter.get('/agent-tasks/:id', async (req, res, next) => {
  try {
    const task = getAgentTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Agent task not found.' });
    }
    res.json({ ok: true, item: task });
  } catch (err) {
    next(err);
  }
});

adminAiRouter.patch('/agent-tasks/:id/status', async (req, res, next) => {
  try {
    const problems = validateAgentTaskStatusPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const updated = updateAgentTaskStatus(req.params.id, req.body.status);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Agent task not found.' });
    }
    res.json({ ok: true, task: updated });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminAiRouter);

// ---------------------------------------------------------------------------
// Inspector workflow — admin-managed only. No technician login, no
// public-facing account, no automatic payouts (this step adds no
// financial fields to inspectors/inspection_jobs at all — see
// backend/README.md's "Inspector workflow" section for the full
// picture). Every status transition here is something an admin
// explicitly sets via PATCH; nothing moves on its own.
// ---------------------------------------------------------------------------

const adminInspectorsRouter = express.Router();
adminInspectorsRouter.use(requireAdmin);

adminInspectorsRouter.get('/inspectors', async (req, res, next) => {
  try {
    let inspectors = findAllInspectors().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (req.query.active !== undefined) {
      const wantActive = String(req.query.active).toLowerCase() === 'true';
      inspectors = inspectors.filter((i) => i.active === wantActive);
    }
    if (req.query.city) {
      inspectors = inspectors.filter((i) => (i.city || '').toLowerCase() === String(req.query.city).toLowerCase());
    }
    if (req.query.search) {
      const q = String(req.query.search).trim().toLowerCase();
      inspectors = inspectors.filter((i) =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.email || '').toLowerCase().includes(q) ||
        (i.city || '').toLowerCase().includes(q)
      );
    }

    const total = inspectors.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ ok: true, items: inspectors.slice(offset, offset + limit), total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /inspectors/:id on purpose — otherwise Express would
// match "export.csv" itself as an :id value (same gotcha as every other
// admin router in this file).
adminInspectorsRouter.get('/inspectors/export.csv', async (req, res, next) => {
  try {
    const inspectors = findAllInspectors().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const rows = [INSPECTOR_CSV_COLUMNS.join(',')];
    for (const inspector of inspectors) {
      rows.push(INSPECTOR_CSV_COLUMNS.map((col) => csvEscape(inspector[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inspectors-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.get('/inspectors/:id', async (req, res, next) => {
  try {
    const inspector = findInspectorById(req.params.id);
    if (!inspector) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Inspector not found.' });
    }
    res.json({ ok: true, item: inspector });
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.post('/inspectors', async (req, res, next) => {
  try {
    const problems = validateInspectorPayload(req.body, { isCreate: true });
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const inspector = insertInspector({
      name: str(req.body.name),
      email: str(req.body.email) || null,
      phone: str(req.body.phone) || null,
      city: str(req.body.city) || null,
      qualification: str(req.body.qualification) || null,
      active: req.body.active !== undefined ? req.body.active : true,
      internalNote: str(req.body.internalNote) || null
    });
    res.status(201).json({ ok: true, item: inspector });
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.patch('/inspectors/:id', async (req, res, next) => {
  try {
    const problems = validateInspectorPayload(req.body, { isCreate: false });
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const updated = updateInspectorById(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Inspector not found.' });
    }
    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

// Booking.status only ever advances FORWARD through this known sequence,
// never backward, and never touches a booking whose status is outside
// it (e.g. cancelled/spam/archived) — see the callers below for exactly
// when each step fires.
const BOOKING_INSPECTION_STATUS_SEQUENCE = ['paid', 'inspector_needed', 'inspector_assigned', 'inspection_scheduled', 'completed'];

function advanceBookingStatusIfBehind(bookingId, targetStatus) {
  const booking = findBookingById(bookingId);
  if (!booking) return;
  const currentIndex = BOOKING_INSPECTION_STATUS_SEQUENCE.indexOf(booking.status);
  const targetIndex = BOOKING_INSPECTION_STATUS_SEQUENCE.indexOf(targetStatus);
  if (currentIndex === -1 || targetIndex === -1) return;
  if (targetIndex > currentIndex) {
    updateBookingStatusById(bookingId, targetStatus);
  }
}

adminInspectorsRouter.get('/inspection-jobs', async (req, res, next) => {
  try {
    const { items, total } = listInspectionJobs(req.query);
    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.get('/inspection-jobs/export.csv', async (req, res, next) => {
  try {
    const jobs = listAllMatchingInspectionJobs(req.query);
    const rows = [INSPECTION_JOB_CSV_COLUMNS.join(',')];
    for (const job of jobs) {
      rows.push(INSPECTION_JOB_CSV_COLUMNS.map((col) => csvEscape(job[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inspection-jobs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.get('/inspection-jobs/:id', async (req, res, next) => {
  try {
    const job = getInspectionJobById(req.params.id);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Inspection job not found.' });
    }
    res.json({ ok: true, item: job });
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.patch('/inspection-jobs/:id', async (req, res, next) => {
  try {
    const existing = getInspectionJobById(req.params.id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Inspection job not found.' });
    }
    const problems = validateUpdateInspectionJobPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }

    const updated = updateInspectionJob(req.params.id, req.body);

    // Best-effort booking-status sync — never lets a sync problem fail
    // the inspection-job update itself, which has already succeeded.
    try {
      if (req.body.inspectorId !== undefined && req.body.inspectorId !== null && !existing.inspectorId) {
        advanceBookingStatusIfBehind(updated.bookingId, 'inspector_assigned');
      }
      if (req.body.status === 'scheduled') {
        advanceBookingStatusIfBehind(updated.bookingId, 'inspection_scheduled');
      }
      if (req.body.status === 'completed') {
        advanceBookingStatusIfBehind(updated.bookingId, 'completed');
      }
    } catch (syncErr) {
      console.error('[inspection-jobs] booking status sync failed unexpectedly:', syncErr.message);
    }

    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.post('/inspection-jobs/:id/checklist/defaults', async (req, res, next) => {
  try {
    const job = getInspectionJobById(req.params.id);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Inspection job not found.' });
    }
    const existingItems = listChecklistItems(job.id);
    if (existingItems.length > 0) {
      // Not a "reset" — see inspectionChecklistRepository.js's own
      // comment. Calling this again just returns what's already there.
      return res.json({ ok: true, items: existingItems, created: false });
    }
    const items = createDefaultChecklistItems(job.id);
    res.status(201).json({ ok: true, items, created: true });
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.get('/inspection-jobs/:id/checklist', async (req, res, next) => {
  try {
    const job = getInspectionJobById(req.params.id);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Inspection job not found.' });
    }
    res.json({ ok: true, items: listChecklistItems(job.id) });
  } catch (err) {
    next(err);
  }
});

adminInspectorsRouter.patch('/inspection-checklist-items/:id', async (req, res, next) => {
  try {
    const problems = validateChecklistItemPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const updated = updateChecklistItem(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Checklist item not found.' });
    }
    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminInspectorsRouter);

// ---------------------------------------------------------------------------
// Dealer workflow — dealer profiles, their vehicles, and verified
// badges. Two explicit admin gates, both enforced server-side (never
// just hidden in the UI): a badge can only be REQUESTED for a vehicle
// whose dealer is already status="verified" (an admin decision), and a
// requested badge only ever becomes "approved" via an explicit admin
// PATCH (see updateBadgeStatus() in verifiedBadgesRepository.js) — see
// backend/README.md's "Dealer workflow" section for the full picture.
// ---------------------------------------------------------------------------

const adminDealersRouter = express.Router();
adminDealersRouter.use(requireAdmin);

adminDealersRouter.get('/dealers', async (req, res, next) => {
  try {
    let dealers = findAllDealers().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (req.query.status) dealers = dealers.filter((d) => d.status === req.query.status);
    if (req.query.city) dealers = dealers.filter((d) => (d.city || '').toLowerCase() === String(req.query.city).toLowerCase());
    if (req.query.search) {
      const q = String(req.query.search).trim().toLowerCase();
      dealers = dealers.filter((d) =>
        (d.companyName || '').toLowerCase().includes(q) ||
        (d.contactName || '').toLowerCase().includes(q) ||
        (d.email || '').toLowerCase().includes(q) ||
        (d.city || '').toLowerCase().includes(q)
      );
    }

    const total = dealers.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ ok: true, items: dealers.slice(offset, offset + limit), total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /dealers/:id on purpose — otherwise Express would
// match "export.csv"/"from-lead" themselves as an :id value.
adminDealersRouter.get('/dealers/export.csv', async (req, res, next) => {
  try {
    const dealers = findAllDealers().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const rows = [DEALER_CSV_COLUMNS.join(',')];
    for (const dealer of dealers) {
      rows.push(DEALER_CSV_COLUMNS.map((col) => csvEscape(dealer[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dealers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

/**
 * Creates a dealer from an existing dealer_request lead — copies
 * companyName/contactName/email/phone/city across, always starts the
 * new dealer at status="pending" (see insertDealer()'s own comment).
 * NEVER modifies the source lead itself — its own status/fields stay
 * exactly as they were, so this cannot break existing dealer_request
 * lead handling elsewhere in the admin. Idempotent by email: a second
 * attempt from a lead whose email already has a dealer record returns
 * 400 ALREADY_EXISTS with the existing dealer's id, never a duplicate.
 */
adminDealersRouter.post('/dealers/from-lead/:leadId', async (req, res, next) => {
  try {
    const lead = findLeadById(req.params.leadId);
    if (!lead) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lead not found.' });
    }
    if (lead.type !== 'dealer_request') {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `Lead type is "${lead.type}", not "dealer_request" — only dealer_request leads can be converted to a dealer.` });
    }

    const existingDealer = findDealerByEmail(lead.email);
    if (existingDealer) {
      return res.status(400).json({ ok: false, error: 'ALREADY_EXISTS', message: `A dealer with this email already exists (${existingDealer.id}).`, dealerId: existingDealer.id });
    }

    if (!str(lead.companyName)) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: 'This lead has no companyName — cannot create a dealer without one.' });
    }

    const dealer = insertDealer({
      companyName: lead.companyName,
      contactName: lead.contactName,
      email: lead.email,
      phone: lead.phone,
      city: lead.city
    });

    res.status(201).json({ ok: true, item: dealer });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.get('/dealers/:id', async (req, res, next) => {
  try {
    const dealer = findDealerById(req.params.id);
    if (!dealer) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Dealer not found.' });
    }
    res.json({ ok: true, item: dealer });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.post('/dealers', async (req, res, next) => {
  try {
    const problems = validateDealerPayload(req.body, { isCreate: true });
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const dealer = insertDealer({
      companyName: str(req.body.companyName),
      contactName: str(req.body.contactName) || null,
      email: str(req.body.email) || null,
      phone: str(req.body.phone) || null,
      city: str(req.body.city) || null,
      website: str(req.body.website) || null,
      internalNote: str(req.body.internalNote) || null
    });
    res.status(201).json({ ok: true, item: dealer });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.patch('/dealers/:id', async (req, res, next) => {
  try {
    const problems = validateDealerPayload(req.body, { isCreate: false });
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const updated = updateDealerById(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Dealer not found.' });
    }
    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.get('/dealer-vehicles', async (req, res, next) => {
  try {
    let vehicles = findAllDealerVehicles().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (req.query.dealerId) vehicles = vehicles.filter((v) => v.dealerId === req.query.dealerId);
    if (req.query.status) vehicles = vehicles.filter((v) => v.status === req.query.status);
    if (req.query.search) {
      const q = String(req.query.search).trim().toLowerCase();
      vehicles = vehicles.filter((v) =>
        (v.vin || '').toLowerCase().includes(q) ||
        (v.make || '').toLowerCase().includes(q) ||
        (v.model || '').toLowerCase().includes(q)
      );
    }

    const total = vehicles.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ ok: true, items: vehicles.slice(offset, offset + limit), total });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.get('/dealer-vehicles/export.csv', async (req, res, next) => {
  try {
    let vehicles = findAllDealerVehicles().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (req.query.dealerId) vehicles = vehicles.filter((v) => v.dealerId === req.query.dealerId);
    const rows = [DEALER_VEHICLE_CSV_COLUMNS.join(',')];
    for (const vehicle of vehicles) {
      rows.push(DEALER_VEHICLE_CSV_COLUMNS.map((col) => csvEscape(vehicle[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dealer-vehicles-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.get('/dealer-vehicles/:id', async (req, res, next) => {
  try {
    const vehicle = findDealerVehicleById(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Vehicle not found.' });
    }
    res.json({ ok: true, item: vehicle });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.post('/dealer-vehicles', async (req, res, next) => {
  try {
    const problems = validateDealerVehiclePayload(req.body, { isCreate: true });
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const vehicle = insertDealerVehicle({
      dealerId: str(req.body.dealerId),
      vin: str(req.body.vin) || null,
      make: str(req.body.make) || null,
      model: str(req.body.model) || null,
      year: req.body.year ? Number(req.body.year) : null,
      listingUrl: str(req.body.listingUrl) || null,
      status: req.body.status || 'active'
    });
    res.status(201).json({ ok: true, item: vehicle });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.patch('/dealer-vehicles/:id', async (req, res, next) => {
  try {
    const problems = validateDealerVehiclePayload(req.body, { isCreate: false });
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const updated = updateDealerVehicleById(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Vehicle not found.' });
    }
    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * Requests a badge for a vehicle. Two enforced conditions, both
 * server-side (not just UI-hidden):
 *   - the vehicle's dealer must be status="verified" — an admin
 *     decision made separately, on the dealer, before any of their
 *     vehicles are even eligible for a badge request;
 *   - the vehicle must not already have an active (requested/approved)
 *     badge — idempotent, returns the existing badge's id on repeat.
 * This only ever creates a status="requested" row — it does NOT
 * approve anything. See PATCH /admin/badges/:id/status for the only
 * path to "approved", which is always a separate, explicit admin call.
 */
adminDealersRouter.post('/dealer-vehicles/:id/badge', async (req, res, next) => {
  try {
    const vehicle = findDealerVehicleById(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Vehicle not found.' });
    }
    const dealer = findDealerById(vehicle.dealerId);
    if (!dealer || dealer.status !== 'verified') {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: `This vehicle's dealer status is "${dealer ? dealer.status : 'unknown'}", not "verified" — only a verified dealer's vehicles can request a badge.` });
    }
    if (hasActiveBadgeForVehicle(vehicle.id)) {
      const existing = listBadges({ vehicleId: vehicle.id }).items.find((b) => ['requested', 'approved'].includes(b.status));
      return res.status(400).json({ ok: false, error: 'ALREADY_EXISTS', message: `This vehicle already has an active badge (${existing.id}, status: ${existing.status}).`, badgeId: existing.id });
    }

    const badge = createBadgeRequest({ dealerId: dealer.id, vehicleId: vehicle.id });
    res.status(201).json({ ok: true, item: badge });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.get('/badges', async (req, res, next) => {
  try {
    const { items, total } = listBadges(req.query);
    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.get('/badges/export.csv', async (req, res, next) => {
  try {
    const badges = listAllMatchingBadges(req.query);
    const rows = [BADGE_CSV_COLUMNS.join(',')];
    for (const badge of badges) {
      rows.push(BADGE_CSV_COLUMNS.map((col) => csvEscape(badge[col])).join(','));
    }
    const csv = rows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="badges-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.get('/badges/:id', async (req, res, next) => {
  try {
    const badge = getBadgeById(req.params.id);
    if (!badge) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Badge not found.' });
    }
    res.json({ ok: true, item: badge });
  } catch (err) {
    next(err);
  }
});

adminDealersRouter.patch('/badges/:id/status', async (req, res, next) => {
  try {
    const existing = getBadgeById(req.params.id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Badge not found.' });
    }
    const problems = validateBadgeStatusPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const updated = updateBadgeStatus(req.params.id, {
      status: req.body.status,
      expiresAt: req.body.expiresAt,
      internalNote: req.body.internalNote
    });
    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminDealersRouter);

// ---------------------------------------------------------------------------
// Revenue-share 20% — transparent bookkeeping only. NOTHING in this
// router ever moves money. See backend/README.md's "Revenue-share 20%"
// section for the full picture: what "eligible monthly revenue" means,
// why every payout starts (and stays, until an admin says otherwise)
// at "pending_manual_transfer", and why a real Wise transfer is
// deliberately a separate, later step.
// ---------------------------------------------------------------------------

const adminRevenueShareRouter = express.Router();
adminRevenueShareRouter.use(requireAdmin);

adminRevenueShareRouter.get('/revenue-share/settings', async (req, res, next) => {
  try {
    res.json({ ok: true, settings: getRevenueShareSettings() });
  } catch (err) {
    next(err);
  }
});

adminRevenueShareRouter.patch('/revenue-share/settings', async (req, res, next) => {
  try {
    const problems = validateRevenueShareSettingsPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const settings = updateRevenueShareSettings(req.body);
    res.json({ ok: true, settings });
  } catch (err) {
    next(err);
  }
});

adminRevenueShareRouter.get('/revenue-share/ledger', async (req, res, next) => {
  try {
    const { items, total } = listLedger(req.query);
    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

adminRevenueShareRouter.get('/revenue-share/ledger/export.csv', async (req, res, next) => {
  try {
    const rows = listAllMatchingLedgerEntries(req.query);
    const csvRows = [REVENUE_SHARE_LEDGER_CSV_COLUMNS.join(',')];
    for (const row of rows) {
      csvRows.push(REVENUE_SHARE_LEDGER_CSV_COLUMNS.map((col) => csvEscape(row[col])).join(','));
    }
    const csv = csvRows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="revenue-share-ledger-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

adminRevenueShareRouter.get('/revenue-share/payouts', async (req, res, next) => {
  try {
    const { items, total } = listPayouts(req.query);
    res.json({ ok: true, items, total });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE /payouts/:id on purpose — otherwise Express would
// match "export.csv" itself as an :id value (same gotcha as every
// other admin router in this file).
adminRevenueShareRouter.get('/revenue-share/payouts/export.csv', async (req, res, next) => {
  try {
    const rows = listAllMatchingPayoutRecords(req.query);
    const csvRows = [MONTHLY_PAYOUT_CSV_COLUMNS.join(',')];
    for (const row of rows) {
      csvRows.push(MONTHLY_PAYOUT_CSV_COLUMNS.map((col) => csvEscape(row[col])).join(','));
    }
    const csv = csvRows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="revenue-share-payouts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    next(err);
  }
});

/**
 * Computes and PERSISTS the payout for one calendar month — creates the
 * monthly_payouts row(s) (one per currency actually present that
 * month) at status="pending_manual_transfer", and moves the
 * corresponding ledger rows to "included_in_payout" in the same pass.
 * This is the ONLY endpoint that creates a payout — nothing runs this
 * automatically (see backend/README.md for the manual-trigger-for-now
 * rationale, and how a cron would call this same logic later).
 */
adminRevenueShareRouter.post('/revenue-share/payouts/calculate', async (req, res, next) => {
  try {
    const problems = validateMonthKeyPayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const payouts = createMonthlyPayout(req.body.monthKey);
    res.status(201).json({ ok: true, payouts });
  } catch (err) {
    if (err.code === 'NOTHING_TO_CALCULATE') {
      return res.status(400).json({ ok: false, error: err.code, message: err.message });
    }
    if (err.code === 'ALREADY_EXISTS') {
      return res.status(400).json({ ok: false, error: err.code, message: err.message, payoutId: err.payoutId });
    }
    next(err);
  }
});

adminRevenueShareRouter.get('/revenue-share/payouts/:id', async (req, res, next) => {
  try {
    const payout = getRevenueSharePayoutById(req.params.id);
    if (!payout) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Payout not found.' });
    }
    res.json({ ok: true, item: payout });
  } catch (err) {
    next(err);
  }
});

/**
 * The ONLY endpoint that can set a payout's status to "paid" — always
 * means "an admin manually completed a transfer (Wise or otherwise)
 * outside this system and is recording that fact here". Never
 * triggers, initiates, or performs any transfer itself — there is no
 * code anywhere in this project that calls Wise's API or moves money
 * automatically.
 */
adminRevenueShareRouter.patch('/revenue-share/payouts/:id/mark-paid', async (req, res, next) => {
  try {
    const payout = markPayoutPaid(req.params.id);
    if (!payout) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Payout not found.' });
    }
    res.json({ ok: true, item: payout });
  } catch (err) {
    if (err.code === 'ALREADY_PAID' || err.code === 'CANCELLED') {
      return res.status(400).json({ ok: false, error: err.code, message: err.message });
    }
    next(err);
  }
});

adminRevenueShareRouter.patch('/revenue-share/payouts/:id/note', async (req, res, next) => {
  try {
    const problems = validatePayoutNotePayload(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', message: problems.join(' ') });
    }
    const updated = updateRevenueSharePayout(req.params.id, { internalNote: req.body.internalNote });
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Payout not found.' });
    }
    res.json({ ok: true, item: updated });
  } catch (err) {
    next(err);
  }
});

app.use('/admin', adminRevenueShareRouter);

/**
 * Public badge lookup — deliberately NOT behind requireAdmin. Returns
 * ONLY safe fields: badge status, the dealer's companyName (never
 * contactName/email/phone/internalNote), the vehicle's make/model/year/
 * vin/listingUrl (never any internal id beyond the badge/vehicle's own
 * public-safe identifiers), issuedAt/expiresAt, and a disclaimer.
 * Always reflects the badge's TRUE current status — including
 * "requested"/"rejected"/"revoked"/"expired" — never shows "approved"
 * for anything that isn't. A 404 here doesn't distinguish "code never
 * existed" from "code exists but is somehow invalid" — same generic
 * message either way, so this can't be used to enumerate valid codes.
 */
app.get('/badges/public/:badgeCode', rateLimit('badges-public'), async (req, res, next) => {
  try {
    const badge = getBadgeByCode(req.params.badgeCode);
    if (!badge) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Badge not found.' });
    }
    const dealer = findDealerById(badge.dealerId);
    const vehicle = findDealerVehicleById(badge.vehicleId);

    res.json({
      ok: true,
      badge: {
        status: badge.status,
        badgeCode: badge.badgeCode,
        issuedAt: badge.issuedAt,
        expiresAt: badge.expiresAt
      },
      dealer: dealer ? { companyName: dealer.companyName } : null,
      vehicle: vehicle ? { vin: vehicle.vin, make: vehicle.make, model: vehicle.model, year: vehicle.year, listingUrl: vehicle.listingUrl } : null,
      disclaimer: 'This badge reflects NEXIUM\'s own verification process at the time it was issued. It does not certify every claim made by the dealer or seller, and does not replace an independent inspection.'
    });
  } catch (err) {
    next(err);
  }
});

// Public — deliberately NOT behind requireAdmin, NOT on adminReportsRouter.
// The only "auth" here is knowing the exact 64-character token — see
// generatePublicToken() in reportsRepository.js for how that's generated.
app.get('/reports/public/:token', rateLimit('reports-public'), async (req, res, next) => {
  try {
    const report = getReportByPublicToken(req.params.token);
    if (!report) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }
    if (report.publicTokenRevokedAt) {
      return res.status(410).json({ ok: false, error: 'GONE', message: 'This link has been revoked.' });
    }
    // Only serve a report once there's actually something meant to be
    // shown — never expose a report that's still created/in_review/
    // draft_ready/cancelled through this path, even if someone somehow
    // has (or guesses part of) a token for it. Treated the same as "not
    // found" rather than a more specific error, so this endpoint never
    // confirms a token's existence for a report that isn't ready yet.
    if (!['report_ready', 'report_sent', 'completed'].includes(report.status)) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Report not found.' });
    }

    const sections = listSections(report.id).map((s) => ({ sectionKey: s.sectionKey, title: s.title, content: s.content, sortOrder: s.sortOrder }));

    // Safe public fields ONLY — explicitly NOT internalNote, NOT
    // publicToken itself, NOT customerEmail (PII, and the viewer already
    // has the link — no reason to echo it back), NOT status history, NOT
    // anything payment-related (this table doesn't carry those fields at
    // all, but worth stating: this is a deliberate allowlist, not "return
    // the row minus a few fields").
    const publicReport = {
      id: report.id,
      reportType: report.reportType,
      title: report.title,
      summary: report.summary,
      verdict: report.verdict,
      riskLevel: report.riskLevel,
      score: report.score,
      status: report.status,
      createdAt: report.createdAt,
      completedAt: report.completedAt
    };

    res.json({ ok: true, report: publicReport, sections });
  } catch (err) {
    next(err);
  }
});

// Unknown routes
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
});

// Central error handler — also catches express.json()'s "payload too large" error.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') {
    return res.status(400).json({ ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'INVALID_JSON', message: 'Request body is not valid JSON.' });
  }
  console.error('Unexpected server error:', err);
  res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  seedPromptsIfNeeded();
  console.log('database initialized');
  console.log(`database path: ${DB_PATH}`);
  console.log('tables ready: leads, bookings, vin_checks, email_logs, payments');
  console.log('');
  console.log(`nexium-backend listening on http://localhost:${PORT}`);
  console.log(`  GET   /health`);
  console.log(`  POST  /leads`);
  console.log(`  POST  /bookings`);
  console.log(`  POST  /vin/check`);
  console.log(`  POST  /payments/checkout`);
  console.log(`  POST  /payments/webhook`);
  console.log(`  GET   /admin/leads               (x-admin-password required)`);
  console.log(`  GET   /admin/leads/export.csv    (x-admin-password required)`);
  console.log(`  GET   /admin/leads/:id           (x-admin-password required)`);
  console.log(`  PATCH /admin/leads/:id/status    (x-admin-password required)`);
  console.log(`  PATCH /admin/leads/:id/note      (x-admin-password required)`);
  console.log(`  DELETE /admin/leads/:id          (x-admin-password required)`);
  console.log(`  GET   /admin/bookings            (x-admin-password required)`);
  console.log(`  GET   /admin/bookings/export.csv (x-admin-password required)`);
  console.log(`  GET   /admin/bookings/:id        (x-admin-password required)`);
  console.log(`  PATCH /admin/bookings/:id/status (x-admin-password required)`);
  console.log(`  PATCH /admin/bookings/:id/note   (x-admin-password required)`);
  console.log(`  DELETE /admin/bookings/:id       (x-admin-password required)`);
  console.log(`  GET   /admin/vin-checks            (x-admin-password required)`);
  console.log(`  GET   /admin/vin-checks/export.csv (x-admin-password required)`);
  console.log(`  GET   /admin/vin-checks/:id        (x-admin-password required)`);
  console.log(`  PATCH /admin/vin-checks/:id/note   (x-admin-password required)`);
  console.log(`  GET   /admin/email-logs            (x-admin-password required)`);
  console.log(`  GET   /admin/email-logs/:id        (x-admin-password required)`);
  console.log(`  GET   /admin/email-logs/export.csv (x-admin-password required)`);
  console.log(`  PATCH /admin/email-logs/:id/review (x-admin-password required)`);
  console.log(`  GET   /admin/payments            (x-admin-password required)`);
  console.log(`  GET   /admin/payments/export.csv (x-admin-password required)`);
  console.log(`  GET   /admin/payments/:id        (x-admin-password required)`);
  console.log(`  PATCH /admin/payments/:id/note   (x-admin-password required)`);
  console.log(`  PATCH /admin/payments/:id/assign (x-admin-password required)`);
  console.log(`  PATCH /admin/leads/:id/assign      (x-admin-password required)`);
  console.log(`  PATCH /admin/bookings/:id/assign   (x-admin-password required)`);
  console.log(`  PATCH /admin/vin-checks/:id/assign (x-admin-password required)`);
  console.log(`  POST  /admin/vin-checks/:id/run-provider    (x-admin-password required)`);
  console.log(`  GET   /admin/vin-checks/:id/provider-runs   (x-admin-password required)`);
  console.log(`  GET   /admin/agents            (x-admin-password required)`);
  console.log(`  GET   /admin/agents/:id        (x-admin-password required)`);
  console.log(`  POST  /admin/agents            (x-admin-password required)`);
  console.log(`  PATCH /admin/agents/:id        (x-admin-password required)`);
  console.log(`  GET   /admin/reports              (x-admin-password required)`);
  console.log(`  GET   /admin/reports/export.csv   (x-admin-password required)`);
  console.log(`  GET   /admin/reports/:id          (x-admin-password required)`);
  console.log(`  GET   /admin/reports/:id/history  (x-admin-password required)`);
  console.log(`  PATCH /admin/reports/:id/status   (x-admin-password required)`);
  console.log(`  PATCH /admin/reports/:id/note     (x-admin-password required)`);
  console.log(`  PATCH /admin/reports/:id/summary  (x-admin-password required)`);
  console.log(`  GET   /admin/reports/:id/sections           (x-admin-password required)`);
  console.log(`  PATCH /admin/report-sections/:sectionId      (x-admin-password required)`);
  console.log(`  PATCH /admin/reports/:id/sections/reorder    (x-admin-password required)`);
  console.log(`  POST  /admin/reports/:id/sections/reset-defaults (x-admin-password required)`);
  console.log(`  GET   /admin/reports/:id/preview             (x-admin-password required)`);
  console.log(`  POST   /admin/reports/:id/public-token       (x-admin-password required)`);
  console.log(`  DELETE /admin/reports/:id/public-token       (x-admin-password required)`);
  console.log(`  POST   /admin/reports/:id/send-to-customer   (x-admin-password required)`);
  console.log(`  GET    /reports/public/:token                (PUBLIC — no password)`);
  console.log(`  POST   /admin/ai/run                (x-admin-password required)`);
  console.log(`  GET    /admin/ai/runs               (x-admin-password required)`);
  console.log(`  GET    /admin/ai/runs/export.csv    (x-admin-password required)`);
  console.log(`  GET    /admin/ai/runs/:id           (x-admin-password required)`);
  console.log(`  PATCH  /admin/ai/runs/:id/review    (x-admin-password required)`);
  console.log(`  POST   /admin/ai/runs/:id/apply     (x-admin-password required)`);
  console.log(`  POST  /admin/agents/run-business-agent    (x-admin-password required)`);
  console.log(`  GET   /admin/agent-tasks                  (x-admin-password required)`);
  console.log(`  GET   /admin/agent-tasks/export.csv       (x-admin-password required)`);
  console.log(`  GET   /admin/agent-tasks/:id              (x-admin-password required)`);
  console.log(`  PATCH /admin/agent-tasks/:id/status       (x-admin-password required)`);
  console.log(`  GET   /admin/inspectors                        (x-admin-password required)`);
  console.log(`  GET   /admin/inspectors/export.csv             (x-admin-password required)`);
  console.log(`  GET   /admin/inspectors/:id                    (x-admin-password required)`);
  console.log(`  POST  /admin/inspectors                        (x-admin-password required)`);
  console.log(`  PATCH /admin/inspectors/:id                    (x-admin-password required)`);
  console.log(`  POST  /admin/bookings/:id/inspection-job       (x-admin-password required)`);
  console.log(`  GET   /admin/inspection-jobs                   (x-admin-password required)`);
  console.log(`  GET   /admin/inspection-jobs/export.csv        (x-admin-password required)`);
  console.log(`  GET   /admin/inspection-jobs/:id               (x-admin-password required)`);
  console.log(`  PATCH /admin/inspection-jobs/:id                (x-admin-password required)`);
  console.log(`  POST  /admin/inspection-jobs/:id/checklist/defaults (x-admin-password required)`);
  console.log(`  GET   /admin/inspection-jobs/:id/checklist          (x-admin-password required)`);
  console.log(`  PATCH /admin/inspection-checklist-items/:id         (x-admin-password required)`);
  console.log(`  GET   /admin/dealers                       (x-admin-password required)`);
  console.log(`  GET   /admin/dealers/export.csv            (x-admin-password required)`);
  console.log(`  GET   /admin/dealers/:id                   (x-admin-password required)`);
  console.log(`  POST  /admin/dealers                       (x-admin-password required)`);
  console.log(`  PATCH /admin/dealers/:id                   (x-admin-password required)`);
  console.log(`  POST  /admin/dealers/from-lead/:leadId      (x-admin-password required)`);
  console.log(`  GET   /admin/dealer-vehicles                (x-admin-password required)`);
  console.log(`  GET   /admin/dealer-vehicles/export.csv     (x-admin-password required)`);
  console.log(`  GET   /admin/dealer-vehicles/:id            (x-admin-password required)`);
  console.log(`  POST  /admin/dealer-vehicles                (x-admin-password required)`);
  console.log(`  PATCH /admin/dealer-vehicles/:id            (x-admin-password required)`);
  console.log(`  POST  /admin/dealer-vehicles/:id/badge      (x-admin-password required)`);
  console.log(`  GET   /admin/badges                         (x-admin-password required)`);
  console.log(`  GET   /admin/badges/export.csv              (x-admin-password required)`);
  console.log(`  GET   /admin/badges/:id                     (x-admin-password required)`);
  console.log(`  PATCH /admin/badges/:id/status              (x-admin-password required)`);
  console.log(`  GET   /admin/revenue-share/settings              (x-admin-password required)`);
  console.log(`  PATCH /admin/revenue-share/settings              (x-admin-password required)`);
  console.log(`  GET   /admin/revenue-share/ledger                (x-admin-password required)`);
  console.log(`  GET   /admin/revenue-share/ledger/export.csv     (x-admin-password required)`);
  console.log(`  GET   /admin/revenue-share/payouts               (x-admin-password required)`);
  console.log(`  GET   /admin/revenue-share/payouts/export.csv    (x-admin-password required)`);
  console.log(`  POST  /admin/revenue-share/payouts/calculate     (x-admin-password required)`);
  console.log(`  GET   /admin/revenue-share/payouts/:id           (x-admin-password required)`);
  console.log(`  PATCH /admin/revenue-share/payouts/:id/mark-paid (x-admin-password required)`);
  console.log(`  PATCH /admin/revenue-share/payouts/:id/note      (x-admin-password required)`);
  console.log(`  GET   /badges/public/:badgeCode             (PUBLIC — no password)`);
  console.log('');
  console.log(`environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`email notifications: ${isEmailEnabled() ? 'ENABLED' : 'disabled (EMAIL_ENABLED=false)'}`);
  console.log(`payments: ${PAYMENTS_ENABLED ? `ENABLED (provider: ${PAYMENT_PROVIDER_NAME})` : 'disabled (PAYMENTS_ENABLED=false)'}`);
  console.log(`AI orchestrator: ${AI_ENABLED ? `ENABLED (provider: ${AI_PROVIDER_NAME})` : 'disabled (AI_ENABLED=false)'}`);
  console.log(`VIN provider: ${VIN_PROVIDER_NAME}${VIN_PROVIDER_NAME !== 'demo' ? ` (payment-required: ${VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK})` : ''} — public POST /vin/check always uses demo regardless of this setting`);
  try {
    const rsSettings = getRevenueShareSettings();
    console.log(`Revenue-share: ${rsSettings.enabled ? `ENABLED (${rsSettings.sharePercent}%, payout day ${rsSettings.payoutDay} at ${rsSettings.payoutTime} ${rsSettings.timezone})` : 'disabled (revenue_share_settings.enabled=false)'} — no automatic money transfer exists anywhere in this codebase regardless of this setting`);
  } catch (err) {
    console.warn('WARNING: could not read revenue-share settings at startup:', err.message);
  }
  console.log(`CORS allowed origins: ${CORS_ALLOWED_ORIGINS.join(', ')}`);
  console.log(`rate limit: ${RATE_LIMIT_MAX_REQUESTS} req/${RATE_LIMIT_WINDOW_MS / 1000}s per IP on public write endpoints`);
  // DEV_MOCK_FALLBACK lives in js/api/api.js (frontend), not here — the
  // backend can't read or control it, only remind whoever's reading this
  // log to go check it before calling this deploy production-ready.
  console.log('frontend mock fallback (js/api/api.js DEV_MOCK_FALLBACK): NOT visible from the backend — verify it is `false` before production, see backend/README.md');
  if (PAYMENTS_ENABLED && PAYMENT_PROVIDER_NAME === 'stripe' && !process.env.STRIPE_SECRET_KEY) {
    console.warn('WARNING: PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY is not set — POST /payments/checkout will return an error until it is.');
  }
  if (AI_ENABLED && AI_PROVIDER_NAME === 'openai' && (!process.env.OPENAI_API_KEY || !(AI_MONTHLY_BUDGET_LIMIT > 0))) {
    const missing = [];
    if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
    if (!(AI_MONTHLY_BUDGET_LIMIT > 0)) missing.push('AI_MONTHLY_BUDGET_LIMIT (currently 0 or unset)');
    console.warn(`WARNING: AI_PROVIDER=openai but ${missing.join(' and ')} not set — POST /admin/ai/run will return PROVIDER_NOT_CONFIGURED until both are. Also note: no real OpenAI call is implemented in this step regardless — only "mock" runs real agent calls. See backend/README.md's "GPT API readiness" section.`);
  } else if (AI_ENABLED && AI_PROVIDER_NAME !== 'mock' && AI_PROVIDER_NAME !== 'openai' && !process.env.AI_API_KEY) {
    console.warn(`WARNING: AI_PROVIDER=${AI_PROVIDER_NAME} but AI_API_KEY is not set — POST /admin/ai/run will return PROVIDER_NOT_CONFIGURED until it is (and note: "${AI_PROVIDER_NAME}" isn't actually implemented yet in this step regardless — only "mock" runs real agent calls).`);
  }
  if (VIN_PROVIDER_NAME === 'real' && !(process.env.VIN_API_BASE_URL && process.env.VIN_API_KEY)) {
    console.warn('WARNING: VIN_PROVIDER=real but VIN_API_BASE_URL and/or VIN_API_KEY is not set — POST /admin/vin-checks/:id/run-provider will return PROVIDER_NOT_CONFIGURED until both are set. Also see backend/README.md for the ToS/legal note before picking a real provider.');
  }
  if (isEmailEnabled() && !process.env.SMTP_HOST) {
    console.warn('WARNING: EMAIL_ENABLED=true but SMTP_HOST is not set — every email attempt will be logged as failed until SMTP is configured.');
  }
  if (ADMIN_PASSWORD === 'change_me') {
    console.warn('WARNING: ADMIN_PASSWORD is not set — using the insecure default "change_me". Set it in backend/.env before exposing this server beyond your own machine.');
  }
  if (CORS_IS_LOCALHOST_ONLY) {
    console.warn('WARNING: CORS is only open to local dev origins. Set CORS_ORIGINS in .env to your real domain(s) before deploying.');
  }
});

import crypto from 'crypto';
import { db } from '../database.js';
import { createDefaultSections } from './reportSectionsRepository.js';

export const REPORT_STATUSES = ['created', 'in_review', 'draft_ready', 'report_ready', 'report_sent', 'completed', 'cancelled'];
export const REPORT_TYPES = ['vin_basic_report', 'manual_car_review', 'inspection_report'];
export const REPORT_ENTITY_TYPES = ['vin_check', 'booking', 'manual_review'];

// Which status transition sets which dedicated timestamp column — kept
// here (not scattered across callers) since both updateReportStatus() and
// any future admin bulk-action would need the exact same mapping.
const STATUS_TIMESTAMP_COLUMN = {
  draft_ready: 'draftReadyAt',
  report_ready: 'reportReadyAt',
  report_sent: 'sentAt',
  completed: 'completedAt',
  cancelled: 'cancelledAt'
};

const REPORT_COLUMNS = [
  'id', 'entityType', 'entityId', 'status', 'reportType', 'title', 'summary',
  'verdict', 'riskLevel', 'score', 'language', 'customerEmail', 'internalNote',
  'createdAt', 'updatedAt'
];

const insertStmt = db.prepare(`
  INSERT INTO reports (${REPORT_COLUMNS.join(', ')})
  VALUES (${REPORT_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM reports');
const selectByIdStmt = db.prepare('SELECT * FROM reports WHERE id = ?');
const selectByEntityStmt = db.prepare('SELECT * FROM reports WHERE entityType = ? AND entityId = ?');
const updateStatusStmt = db.prepare(`
  UPDATE reports
  SET status = @status, updatedAt = @updatedAt, draftReadyAt = @draftReadyAt,
      reportReadyAt = @reportReadyAt, sentAt = @sentAt, completedAt = @completedAt,
      cancelledAt = @cancelledAt
  WHERE id = @id
`);
const updateNoteStmt = db.prepare('UPDATE reports SET internalNote = ?, updatedAt = ? WHERE id = ?');
const touchStmt = db.prepare('UPDATE reports SET updatedAt = ? WHERE id = ?');
const setPublicTokenStmt = db.prepare('UPDATE reports SET publicToken = ?, publicTokenCreatedAt = ?, publicTokenRevokedAt = NULL, updatedAt = ? WHERE id = ?');
const revokePublicTokenStmt = db.prepare('UPDATE reports SET publicTokenRevokedAt = ?, updatedAt = ? WHERE id = ?');
const selectByPublicTokenStmt = db.prepare('SELECT * FROM reports WHERE publicToken = ?');
const markDeliveredStmt = db.prepare('UPDATE reports SET deliveredAt = ?, updatedAt = ? WHERE id = ?');
const updateSummaryStmt = db.prepare(`
  UPDATE reports
  SET title = @title, summary = @summary, verdict = @verdict,
      riskLevel = @riskLevel, score = @score, updatedAt = @updatedAt
  WHERE id = @id
`);

const insertHistoryStmt = db.prepare(`
  INSERT INTO report_status_history (id, reportId, oldStatus, newStatus, reason, createdAt)
  VALUES (@id, @reportId, @oldStatus, @newStatus, @reason, @createdAt)
`);
const selectHistoryStmt = db.prepare('SELECT * FROM report_status_history WHERE reportId = ? ORDER BY createdAt ASC');

function generateReportId() {
  return 'report_' + crypto.randomBytes(6).toString('hex');
}

function generateHistoryId() {
  return 'reporthist_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Creates a report. Callers are responsible for idempotency (checking
 * getReportByEntity() first) — this function itself always inserts, on
 * purpose, so it stays a simple primitive other call sites can trust.
 * Also writes the first report_status_history row (oldStatus: null ->
 * newStatus: 'created', reason: 'Report created').
 */
export function createReport(data) {
  const now = new Date().toISOString();
  const report = {
    id: data.id || generateReportId(),
    entityType: data.entityType,
    entityId: data.entityId,
    status: data.status || 'created',
    reportType: data.reportType,
    title: data.title ?? null,
    summary: data.summary ?? null,
    verdict: data.verdict ?? null,
    riskLevel: data.riskLevel ?? null,
    score: data.score ?? null,
    language: data.language ?? null,
    customerEmail: data.customerEmail ?? null,
    internalNote: data.internalNote ?? null,
    createdAt: now,
    updatedAt: now
  };

  insertStmt.run(report);
  insertHistoryStmt.run({
    id: generateHistoryId(),
    reportId: report.id,
    oldStatus: null,
    newStatus: report.status,
    reason: data.creationReason || 'Report created',
    createdAt: now
  });

  // Auto-create the default section set for this reportType (see
  // reportSectionsRepository.js) — silently does nothing for a
  // reportType with no default map entry (e.g. a future
  // inspection_report), so this never blocks report creation itself.
  createDefaultSections(report.id, report.reportType);

  return getReportById(report.id);
}

function filterReportRows(filters) {
  let reports = selectAllStmt.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filters.status) reports = reports.filter((r) => r.status === filters.status);
  if (filters.reportType) reports = reports.filter((r) => r.reportType === filters.reportType);
  if (filters.entityType) reports = reports.filter((r) => r.entityType === filters.entityType);
  if (filters.entityId) reports = reports.filter((r) => r.entityId === filters.entityId);
  if (filters.customerEmail) {
    const q = String(filters.customerEmail).trim().toLowerCase();
    reports = reports.filter((r) => (r.customerEmail || '').toLowerCase() === q);
  }
  if (filters.search) {
    const q = String(filters.search).trim().toLowerCase();
    reports = reports.filter((r) =>
      (r.id || '').toLowerCase().includes(q) ||
      (r.entityId || '').toLowerCase().includes(q) ||
      (r.customerEmail || '').toLowerCase().includes(q) ||
      (r.title || '').toLowerCase().includes(q) ||
      (r.verdict || '').toLowerCase().includes(q)
    );
  }

  return reports;
}

/**
 * Filters + sorts + paginates in JS, same pattern as every other
 * admin list route in this backend — `filters` may include any of:
 * status, reportType, entityType, entityId, customerEmail, search,
 * limit, offset. Returns { items, total } (total = count BEFORE
 * limit/offset, so the caller can show "N of M"). Paginated (max 200
 * per call) — for CSV export, where every matching row is needed
 * regardless of count, use listAllMatchingReports() instead.
 */
export function listReports(filters = {}) {
  const reports = filterReportRows(filters);

  const total = reports.length;
  const offset = Math.max(0, parseInt(filters.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit, 10) || 50));
  const items = reports.slice(offset, offset + limit);

  return { items, total };
}

/** Same filters as listReports(), but returns every matching row,
 * unpaginated — used only by GET /admin/reports/export.csv, where
 * truncating to 200 rows would silently drop data from the export. */
export function listAllMatchingReports(filters = {}) {
  return filterReportRows(filters);
}

export function getReportById(id) {
  return selectByIdStmt.get(id) || null;
}

/** Returns the single report for this entity, or null. Used both by
 * admin lookups and by the payment→report auto-creation idempotency
 * check (see paymentService.js) — entityType+entityId is treated as a
 * unique key in this step's scope (one report per entity). */
export function getReportByEntity(entityType, entityId) {
  return selectByEntityStmt.get(entityType, entityId) || null;
}

export function reportExistsForEntity(entityType, entityId) {
  return !!getReportByEntity(entityType, entityId);
}

/**
 * Transitions a report to a new status, records the transition in
 * report_status_history, and sets the matching dedicated timestamp
 * column (draftReadyAt/reportReadyAt/sentAt/completedAt/cancelledAt) if
 * this status has one — see STATUS_TIMESTAMP_COLUMN above. Does NOT
 * re-set a timestamp that's already set (so re-entering the same status
 * twice, or moving away and back, doesn't silently overwrite the first
 * time it happened) — mirrors how paidAt/cancelledAt work on payments.
 * Returns the updated report, or null if no report has that id.
 */
export function updateReportStatus(id, status, reason) {
  const existing = getReportById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const timestampCol = STATUS_TIMESTAMP_COLUMN[status];

  const merged = {
    id,
    status,
    updatedAt: now,
    draftReadyAt: existing.draftReadyAt,
    reportReadyAt: existing.reportReadyAt,
    sentAt: existing.sentAt,
    completedAt: existing.completedAt,
    cancelledAt: existing.cancelledAt
  };
  if (timestampCol && !merged[timestampCol]) {
    merged[timestampCol] = now;
  }

  updateStatusStmt.run(merged);
  insertHistoryStmt.run({
    id: generateHistoryId(),
    reportId: id,
    oldStatus: existing.status,
    newStatus: status,
    reason: reason || null,
    createdAt: now
  });

  return getReportById(id);
}

/** Admin-only free-text note. Does not touch status or any workflow
 * timestamp. Returns the updated report, or null if no report has that
 * id. */
export function updateReportNote(id, internalNote) {
  const existing = getReportById(id);
  if (!existing) return null;

  const updatedAt = new Date().toISOString();
  updateNoteStmt.run(internalNote, updatedAt, id);
  return getReportById(id);
}

/**
 * Updates the report's content fields — title/summary/verdict/riskLevel/
 * score — as a single subset-aware patch (anything omitted from `payload`
 * keeps its current value). Does not touch status/workflow timestamps or
 * internalNote. Returns the updated report, or null if no report has
 * that id.
 */
export function updateReportSummary(id, payload) {
  const existing = getReportById(id);
  if (!existing) return null;

  const merged = {
    id,
    title: payload.title !== undefined ? payload.title : existing.title,
    summary: payload.summary !== undefined ? payload.summary : existing.summary,
    verdict: payload.verdict !== undefined ? payload.verdict : existing.verdict,
    riskLevel: payload.riskLevel !== undefined ? payload.riskLevel : existing.riskLevel,
    score: payload.score !== undefined ? payload.score : existing.score,
    updatedAt: new Date().toISOString()
  };

  updateSummaryStmt.run(merged);
  return getReportById(id);
}

export function listStatusHistory(reportId) {
  return selectHistoryStmt.all(reportId);
}

/** Bumps only updatedAt, nothing else — used when a section is saved
 * (see server.js's PATCH /admin/report-sections/:sectionId), so the
 * report itself reflects that something about it changed even though no
 * field on the reports row itself was touched. No-op (returns null)
 * if no report has that id — callers treat this as best-effort. */
export function touchReport(id) {
  const existing = getReportById(id);
  if (!existing) return null;
  touchStmt.run(new Date().toISOString(), id);
  return getReportById(id);
}

/**
 * Generates a fresh, cryptographically random public token for this
 * report and (re-)activates it — clears any prior revocation, so calling
 * this again after a revoke issues a genuinely new, working link rather
 * than reviving the old (potentially already-shared) one. 32 random
 * bytes as hex = 64 characters, not guessable by brute force. Returns
 * the updated report, or null if no report has that id.
 */
export function generatePublicToken(reportId) {
  const existing = getReportById(reportId);
  if (!existing) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  setPublicTokenStmt.run(token, now, now, reportId);
  return getReportById(reportId);
}

/** Marks the current public token as revoked — the token value itself is
 * kept (not cleared), only publicTokenRevokedAt is set, so
 * getReportByPublicToken() below can distinguish "never existed" (404)
 * from "existed, now revoked" (410) for the exact same lookup. Returns
 * the updated report, or null if no report has that id. */
export function revokePublicToken(reportId) {
  const existing = getReportById(reportId);
  if (!existing) return null;

  revokePublicTokenStmt.run(new Date().toISOString(), new Date().toISOString(), reportId);
  return getReportById(reportId);
}

/** Used by the PUBLIC GET /reports/public/:token route — deliberately a
 * separate, narrow lookup (not exposed to the admin-facing findAllX-style
 * list) so the only way to reach a report through this path is by
 * already knowing its exact 64-character token. Returns null if no
 * report has that token (token never existed, or belongs to no report —
 * the caller can't tell which, on purpose). Does NOT filter out revoked
 * tokens — the caller (server.js route) checks publicTokenRevokedAt
 * itself, so it can return the more specific 410 instead of a flat 404. */
export function getReportByPublicToken(token) {
  return selectByPublicTokenStmt.get(token) || null;
}

/** Sets deliveredAt once — never overwrites an existing value (mirrors
 * paidAt/cancelledAt-style "first time only" timestamps elsewhere in
 * this codebase). Returns the updated report, or null if no report has
 * that id. */
export function markDelivered(reportId) {
  const existing = getReportById(reportId);
  if (!existing) return null;
  if (existing.deliveredAt) return existing; // already delivered — no-op

  const now = new Date().toISOString();
  markDeliveredStmt.run(now, now, reportId);
  return getReportById(reportId);
}

import crypto from 'crypto';
import { db } from '../database.js';

export const INSPECTION_JOB_STATUSES = [
  'created', 'assigned', 'scheduled', 'in_progress', 'checklist_done',
  'admin_review', 'completed', 'cancelled'
];

// Which status transition sets which dedicated timestamp column —
// mirrors the same pattern used for payments/reports (paidAt,
// draftReadyAt, etc.) elsewhere in this backend.
const STATUS_TIMESTAMP_COLUMN = {
  completed: 'completedAt'
};

const JOB_INSERT_COLUMNS = [
  'id', 'bookingId', 'inspectorId', 'status', 'scheduledAt', 'location',
  'customerContact', 'internalNote', 'createdAt', 'updatedAt'
];

const insertStmt = db.prepare(`
  INSERT INTO inspection_jobs (${JOB_INSERT_COLUMNS.join(', ')})
  VALUES (${JOB_INSERT_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM inspection_jobs');
const selectByIdStmt = db.prepare('SELECT * FROM inspection_jobs WHERE id = ?');
const selectByBookingIdStmt = db.prepare('SELECT * FROM inspection_jobs WHERE bookingId = ?');
const updateStmt = db.prepare(`
  UPDATE inspection_jobs
  SET inspectorId = @inspectorId, status = @status, scheduledAt = @scheduledAt,
      location = @location, customerContact = @customerContact, internalNote = @internalNote,
      completedAt = @completedAt, updatedAt = @updatedAt
  WHERE id = @id
`);

function generateJobId() {
  return 'inspectionjob_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Creates an inspection job for a booking — see server.js's
 * POST /admin/bookings/:id/inspection-job for the paid-only /
 * one-job-per-booking enforcement; this function itself just inserts
 * whatever it's given, always with status='created'.
 */
export function createInspectionJob(data) {
  const now = new Date().toISOString();
  const job = {
    id: data.id || generateJobId(),
    bookingId: data.bookingId,
    inspectorId: data.inspectorId ?? null,
    status: 'created',
    scheduledAt: data.scheduledAt ?? null,
    location: data.location ?? null,
    customerContact: data.customerContact ?? null,
    internalNote: data.internalNote ?? null,
    createdAt: now,
    updatedAt: now
  };
  insertStmt.run(job);
  return getInspectionJobById(job.id);
}

export function getInspectionJobById(id) {
  return selectByIdStmt.get(id) || null;
}

/** Used both by the "one job per booking" idempotency check on create,
 * and by admin-bookings.html to show the linked job (if any) on a
 * booking's own detail view. Returns null if this booking has no
 * inspection job yet. */
export function getInspectionJobByBookingId(bookingId) {
  return selectByBookingIdStmt.get(bookingId) || null;
}

function filterInspectionJobRows(filters) {
  let jobs = selectAllStmt.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filters.status) jobs = jobs.filter((j) => j.status === filters.status);
  if (filters.inspectorId) jobs = jobs.filter((j) => j.inspectorId === filters.inspectorId);
  if (filters.bookingId) jobs = jobs.filter((j) => j.bookingId === filters.bookingId);
  if (filters.search) {
    const q = String(filters.search).trim().toLowerCase();
    jobs = jobs.filter((j) =>
      (j.id || '').toLowerCase().includes(q) ||
      (j.bookingId || '').toLowerCase().includes(q) ||
      (j.location || '').toLowerCase().includes(q) ||
      (j.customerContact || '').toLowerCase().includes(q)
    );
  }

  return jobs;
}

/** Paginated list (max 200 per call) — same filter/paginate pattern used
 * throughout this backend. For CSV export, where every matching row is
 * needed, use listAllMatchingInspectionJobs() instead. */
export function listInspectionJobs(filters = {}) {
  const jobs = filterInspectionJobRows(filters);

  const total = jobs.length;
  const offset = Math.max(0, parseInt(filters.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit, 10) || 50));
  const items = jobs.slice(offset, offset + limit);

  return { items, total };
}

export function listAllMatchingInspectionJobs(filters = {}) {
  return filterInspectionJobRows(filters);
}

/**
 * Generic updater for inspectorId/status/scheduledAt/location/
 * customerContact/internalNote — anything omitted from `patch` keeps
 * its current value. Sets `completedAt` the first time status becomes
 * 'completed' (never overwritten after that, mirrors paidAt/
 * draftReadyAt elsewhere). Returns the updated row, or null if no job
 * has that id.
 */
export function updateInspectionJob(id, patch) {
  const existing = getInspectionJobById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const merged = {
    id,
    inspectorId: patch.inspectorId !== undefined ? patch.inspectorId : existing.inspectorId,
    status: patch.status !== undefined ? patch.status : existing.status,
    scheduledAt: patch.scheduledAt !== undefined ? patch.scheduledAt : existing.scheduledAt,
    location: patch.location !== undefined ? patch.location : existing.location,
    customerContact: patch.customerContact !== undefined ? patch.customerContact : existing.customerContact,
    internalNote: patch.internalNote !== undefined ? patch.internalNote : existing.internalNote,
    completedAt: existing.completedAt,
    updatedAt: now
  };

  const timestampCol = STATUS_TIMESTAMP_COLUMN[merged.status];
  if (timestampCol && !merged[timestampCol]) {
    merged[timestampCol] = now;
  }

  updateStmt.run(merged);
  return getInspectionJobById(id);
}

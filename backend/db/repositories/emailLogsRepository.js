import { db } from '../database.js';

const EMAIL_LOG_COLUMNS = [
  'id', 'entityType', 'entityId', 'recipientType', 'recipientEmail',
  'subject', 'status', 'errorMessage', 'createdAt'
];

const insertStmt = db.prepare(`
  INSERT INTO email_logs (${EMAIL_LOG_COLUMNS.join(', ')})
  VALUES (${EMAIL_LOG_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM email_logs');
const selectByIdStmt = db.prepare('SELECT * FROM email_logs WHERE id = ?');
const updateReviewStmt = db.prepare('UPDATE email_logs SET reviewedAt = ?, resolvedAt = ?, internalNote = ? WHERE id = ?');

function toParams(log) {
  const params = {};
  for (const col of EMAIL_LOG_COLUMNS) {
    params[col] = log[col] !== undefined ? log[col] : null;
  }
  return params;
}

export function insertEmailLog(log) {
  insertStmt.run(toParams(log));
  return log;
}

/** Every email log, unfiltered/unsorted — the admin route does filter/sort/paginate in JS. */
export function findAllEmailLogs() {
  return selectAllStmt.all();
}

export function findEmailLogById(id) {
  return selectByIdStmt.get(id) || null;
}

/**
 * Manual admin review state — deliberately separate from `status`, which
 * stays the factual send outcome (sent/failed/skipped) and is never
 * touched here.
 *
 * Rules (all optional/independent — only the keys actually present in
 * `payload` are applied):
 *   reviewed: true  -> reviewedAt = now, but only if it isn't already set
 *   reviewed: false -> reviewedAt = null
 *   resolved: true  -> resolvedAt = now, but only if it isn't already set
 *   resolved: false -> resolvedAt = null
 *   internalNote: string (including '') -> stored as-is
 *   internalNote: undefined (key absent) -> left unchanged
 *
 * Returns the updated row, or null if no email log has that id.
 */
export function updateReviewState(id, payload) {
  const existing = findEmailLogById(id);
  if (!existing) return null;

  let reviewedAt = existing.reviewedAt;
  if (payload.reviewed === true) {
    reviewedAt = existing.reviewedAt || new Date().toISOString();
  } else if (payload.reviewed === false) {
    reviewedAt = null;
  }

  let resolvedAt = existing.resolvedAt;
  if (payload.resolved === true) {
    resolvedAt = existing.resolvedAt || new Date().toISOString();
  } else if (payload.resolved === false) {
    resolvedAt = null;
  }

  let internalNote = existing.internalNote;
  if (payload.internalNote !== undefined) {
    internalNote = payload.internalNote;
  }

  updateReviewStmt.run(reviewedAt, resolvedAt, internalNote, id);
  return findEmailLogById(id);
}

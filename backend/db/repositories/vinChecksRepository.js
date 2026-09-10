import { db } from '../database.js';

// The table is flat; the rest of the backend (and the frontend admin page)
// works with a nested { ..., result: { score, riskLevel, ... } } shape —
// exactly what POST /vin/check has always built and what
// admin-vin-checks.js has always expected. This module is the only place
// that knows about the flat<->nested translation.
const VIN_CHECK_COLUMNS = [
  'id', 'status', 'createdAt', 'updatedAt', 'vin', 'language', 'source', 'pageUrl',
  'score', 'riskLevel', 'year', 'estimatedMileage', 'advertisedMileage',
  'accidents', 'owners', 'odometerRisk', 'verdictKey', 'isDemoResult',
  'disclaimer', 'internalNote', 'paymentStatus', 'paidAt', 'paymentId', 'assignedAgentId'
];

const insertStmt = db.prepare(`
  INSERT INTO vin_checks (${VIN_CHECK_COLUMNS.join(', ')})
  VALUES (${VIN_CHECK_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM vin_checks');
const selectByIdStmt = db.prepare('SELECT * FROM vin_checks WHERE id = ?');
const existsStmt = db.prepare('SELECT COUNT(*) AS n FROM vin_checks WHERE id = ?');
const markPaidStmt = db.prepare('UPDATE vin_checks SET paymentStatus = ?, paidAt = ?, paymentId = ?, updatedAt = ? WHERE id = ?');
const updateNoteStmt = db.prepare('UPDATE vin_checks SET internalNote = ?, updatedAt = ? WHERE id = ?');
const updateAssignedAgentStmt = db.prepare('UPDATE vin_checks SET assignedAgentId = ?, updatedAt = ? WHERE id = ?');

function flattenForInsert(record) {
  const result = record.result || {};
  return {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    vin: record.vin,
    language: record.language ?? null,
    source: record.source ?? null,
    pageUrl: record.pageUrl ?? null,
    score: result.score ?? null,
    riskLevel: result.riskLevel ?? null,
    year: result.year ?? null,
    estimatedMileage: result.estimatedMileage ?? null,
    advertisedMileage: result.advertisedMileage ?? null,
    accidents: result.accidents ?? null,
    owners: result.owners ?? null,
    odometerRisk: result.odometerRisk ?? null,
    verdictKey: result.verdictKey ?? null,
    // SQLite has no boolean type; store the demo flag as 0/1.
    isDemoResult: result.isDemoResult ? 1 : 0,
    disclaimer: result.disclaimer ?? null,
    internalNote: record.internalNote ?? '',
    // Never set at creation time — a VIN check is only ever marked paid
    // later, via markVinCheckPaid() when a linked payment clears.
    paymentStatus: null,
    paidAt: null,
    paymentId: null,
    // Also never set at creation — an admin assigns an agent later.
    assignedAgentId: null
  };
}

function nestRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    vin: row.vin,
    language: row.language,
    source: row.source,
    pageUrl: row.pageUrl,
    result: {
      score: row.score,
      riskLevel: row.riskLevel,
      year: row.year,
      estimatedMileage: row.estimatedMileage,
      advertisedMileage: row.advertisedMileage,
      accidents: row.accidents,
      owners: row.owners,
      odometerRisk: row.odometerRisk,
      verdictKey: row.verdictKey,
      // ...back to a real boolean for anything reading the API response.
      isDemoResult: !!row.isDemoResult,
      disclaimer: row.disclaimer
    },
    internalNote: row.internalNote,
    // Top-level, parallel to internalNote — deliberately NOT nested inside
    // `result` (payment status isn't part of the VIN check result itself).
    paymentStatus: row.paymentStatus,
    paidAt: row.paidAt,
    paymentId: row.paymentId,
    assignedAgentId: row.assignedAgentId
  };
}

/** Inserts a VIN check. Accepts the same nested shape POST /vin/check has
 * always built; returns that same object unchanged (the route handler's
 * HTTP response is built from it directly, before any DB round-trip). */
export function insertVinCheck(record) {
  insertStmt.run(flattenForInsert(record));
  return record;
}

/** Every VIN check, re-nested into the { result: {...} } shape. Callers
 * keep doing filter/sort/paginate in JS, unchanged. */
export function findAllVinChecks() {
  return selectAllStmt.all().map(nestRow);
}

export function findVinCheckById(id) {
  return nestRow(selectByIdStmt.get(id));
}

export function vinCheckExists(id) {
  return existsStmt.get(id).n > 0;
}

/** Called by paymentService.js when a payment for this VIN check clears.
 * Sets paymentStatus='paid' + paidAt/paymentId — the VIN check's own
 * `status` field (always 'completed') is untouched, since payment status
 * and check-completion status are different things. */
export function markVinCheckPaid(id, { paidAt, paymentId }) {
  const updatedAt = new Date().toISOString();
  const info = markPaidStmt.run('paid', paidAt, paymentId, updatedAt, id);
  if (info.changes === 0) return null;
  return findVinCheckById(id);
}

/** Updates the admin-only internalNote on a VIN check. Returns the updated
 * (nested-shape) record, or null if no VIN check has that id — the route
 * handler turns that into a 404. */
export function updateVinCheckNoteById(id, internalNote) {
  const updatedAt = new Date().toISOString();
  const info = updateNoteStmt.run(internalNote, updatedAt, id);
  if (info.changes === 0) return null;
  return findVinCheckById(id);
}

/** assignedAgentId may be a real id or null (to unassign). Returns the
 * updated (nested-shape) record, or null if no VIN check has that id. */
export function updateVinCheckAssignedAgentById(id, assignedAgentId) {
  const updatedAt = new Date().toISOString();
  const info = updateAssignedAgentStmt.run(assignedAgentId, updatedAt, id);
  if (info.changes === 0) return null;
  return findVinCheckById(id);
}

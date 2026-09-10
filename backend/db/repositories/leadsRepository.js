import { db } from '../database.js';

const LEAD_COLUMNS = [
  'id', 'type', 'status', 'createdAt', 'updatedAt', 'language', 'source', 'pageUrl',
  'companyName', 'contactName', 'email', 'phone', 'city', 'vehiclesCount',
  'qualification', 'availability', 'message', 'internalNote'
];

const insertStmt = db.prepare(`
  INSERT INTO leads (${LEAD_COLUMNS.join(', ')})
  VALUES (${LEAD_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM leads');
const selectByIdStmt = db.prepare('SELECT * FROM leads WHERE id = ?');
const updateStatusStmt = db.prepare('UPDATE leads SET status = ?, updatedAt = ? WHERE id = ?');
const updateNoteStmt = db.prepare('UPDATE leads SET internalNote = ?, updatedAt = ? WHERE id = ?');
const updateAssignedAgentStmt = db.prepare('UPDATE leads SET assignedAgentId = ?, updatedAt = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM leads WHERE id = ?');
const existsStmt = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE id = ?');

function toParams(lead) {
  const params = {};
  for (const col of LEAD_COLUMNS) {
    params[col] = lead[col] !== undefined ? lead[col] : null;
  }
  return params;
}

/** Inserts a lead (same shape POST /leads has always built) and returns it as-is. */
export function insertLead(lead) {
  insertStmt.run(toParams(lead));
  return lead;
}

/** Every lead, unfiltered/unsorted — callers keep doing filter/sort/paginate in JS, unchanged. */
export function findAllLeads() {
  return selectAllStmt.all();
}

export function findLeadById(id) {
  return selectByIdStmt.get(id) || null;
}

export function updateLeadStatusById(id, status) {
  const updatedAt = new Date().toISOString();
  const info = updateStatusStmt.run(status, updatedAt, id);
  if (info.changes === 0) return null;
  return findLeadById(id);
}

export function updateLeadNoteById(id, internalNote) {
  const updatedAt = new Date().toISOString();
  const info = updateNoteStmt.run(internalNote, updatedAt, id);
  if (info.changes === 0) return null;
  return findLeadById(id);
}

export function deleteLeadByIdRepo(id) {
  const info = deleteStmt.run(id);
  return info.changes > 0;
}

export function leadExists(id) {
  return existsStmt.get(id).n > 0;
}

/** assignedAgentId may be a real id or null (to unassign). Returns the
 * updated lead, or null if no lead has that id. */
export function updateLeadAssignedAgentById(id, assignedAgentId) {
  const updatedAt = new Date().toISOString();
  const info = updateAssignedAgentStmt.run(assignedAgentId, updatedAt, id);
  if (info.changes === 0) return null;
  return findLeadById(id);
}

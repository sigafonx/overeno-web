import crypto from 'crypto';
import { db } from '../database.js';

const INSPECTOR_COLUMNS = [
  'id', 'name', 'email', 'phone', 'city', 'qualification', 'active',
  'internalNote', 'createdAt', 'updatedAt'
];

const insertStmt = db.prepare(`
  INSERT INTO inspectors (${INSPECTOR_COLUMNS.join(', ')})
  VALUES (${INSPECTOR_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM inspectors');
const selectByIdStmt = db.prepare('SELECT * FROM inspectors WHERE id = ?');
const existsStmt = db.prepare('SELECT COUNT(*) AS n FROM inspectors WHERE id = ?');
const updateStmt = db.prepare(`
  UPDATE inspectors
  SET name = @name, email = @email, phone = @phone, city = @city,
      qualification = @qualification, active = @active, internalNote = @internalNote,
      updatedAt = @updatedAt
  WHERE id = @id
`);

function generateInspectorId() {
  return 'inspector_' + crypto.randomBytes(6).toString('hex');
}

/** SQLite has no boolean type — active is stored as 0/1, this converts
 * back to a real boolean for anything reading the API response. */
function nestRow(row) {
  if (!row) return null;
  return { ...row, active: !!row.active };
}

/**
 * Creates an inspector — this is staff/evidence data (name to schedule
 * against, contact details, city, qualification), NOT a technician
 * login/account. There is no auth, no session, nothing an inspector
 * themselves would ever sign into — see backend/README.md's "Inspector
 * workflow" section for why that's deliberately out of scope here.
 */
export function insertInspector(data) {
  const now = new Date().toISOString();
  const inspector = {
    id: data.id || generateInspectorId(),
    name: data.name,
    email: data.email ?? null,
    phone: data.phone ?? null,
    city: data.city ?? null,
    qualification: data.qualification ?? null,
    active: data.active !== undefined ? (data.active ? 1 : 0) : 1,
    internalNote: data.internalNote ?? null,
    createdAt: now,
    updatedAt: now
  };
  insertStmt.run(inspector);
  return findInspectorById(inspector.id);
}

/** Every inspector, unfiltered/unsorted — the admin route does filter/sort/paginate in JS. */
export function findAllInspectors() {
  return selectAllStmt.all().map(nestRow);
}

export function findInspectorById(id) {
  return nestRow(selectByIdStmt.get(id));
}

export function inspectorExists(id) {
  return existsStmt.get(id).n > 0;
}

/**
 * Generic updater — anything omitted from `patch` keeps its current
 * value. No DELETE endpoint exists (matching agentsRepository.js's own
 * pattern) — set `active: false` to soft-deactivate an inspector
 * instead of removing their history from inspection_jobs. Returns the
 * updated row, or null if no inspector has that id.
 */
export function updateInspectorById(id, patch) {
  const existing = selectByIdStmt.get(id);
  if (!existing) return null;

  const merged = {
    id,
    name: patch.name !== undefined ? patch.name : existing.name,
    email: patch.email !== undefined ? patch.email : existing.email,
    phone: patch.phone !== undefined ? patch.phone : existing.phone,
    city: patch.city !== undefined ? patch.city : existing.city,
    qualification: patch.qualification !== undefined ? patch.qualification : existing.qualification,
    active: patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active,
    internalNote: patch.internalNote !== undefined ? patch.internalNote : existing.internalNote,
    updatedAt: new Date().toISOString()
  };

  updateStmt.run(merged);
  return findInspectorById(id);
}

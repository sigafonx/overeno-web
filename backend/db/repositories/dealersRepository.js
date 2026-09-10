import crypto from 'crypto';
import { db } from '../database.js';

export const DEALER_STATUSES = ['pending', 'verified', 'rejected', 'suspended'];

const DEALER_COLUMNS = [
  'id', 'companyName', 'contactName', 'email', 'phone', 'city', 'website',
  'status', 'internalNote', 'createdAt', 'updatedAt'
];

const insertStmt = db.prepare(`
  INSERT INTO dealers (${DEALER_COLUMNS.join(', ')})
  VALUES (${DEALER_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM dealers');
const selectByIdStmt = db.prepare('SELECT * FROM dealers WHERE id = ?');
const selectByEmailStmt = db.prepare('SELECT * FROM dealers WHERE email = ? COLLATE NOCASE');
const existsStmt = db.prepare('SELECT COUNT(*) AS n FROM dealers WHERE id = ?');
const updateStmt = db.prepare(`
  UPDATE dealers
  SET companyName = @companyName, contactName = @contactName, email = @email,
      phone = @phone, city = @city, website = @website, status = @status,
      internalNote = @internalNote, updatedAt = @updatedAt
  WHERE id = @id
`);

function generateDealerId() {
  return 'dealer_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Creates a dealer — always starts at status='pending', regardless of
 * what the caller passes (see server.js: only PATCH can move a dealer
 * to 'verified', and only an admin ever calls PATCH — there is no path
 * from creation straight to verified). This is the enforcement point
 * for "badge выдаёт только админ" one level up: a dealer can't even be
 * eligible for vehicle badges until an admin has explicitly verified
 * them, not just registered them.
 */
export function insertDealer(data) {
  const now = new Date().toISOString();
  const dealer = {
    id: data.id || generateDealerId(),
    companyName: data.companyName,
    contactName: data.contactName ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    city: data.city ?? null,
    website: data.website ?? null,
    status: 'pending',
    internalNote: data.internalNote ?? null,
    createdAt: now,
    updatedAt: now
  };
  insertStmt.run(dealer);
  return findDealerById(dealer.id);
}

export function findAllDealers() {
  return selectAllStmt.all();
}

export function findDealerById(id) {
  return selectByIdStmt.get(id) || null;
}

/** Used by POST /admin/dealers/from-lead/:leadId for duplicate
 * protection — since dealers has no dedicated "source lead" column
 * (not in this step's schema), matching on email is the simplest
 * reliable signal that a dealer was already created from this same
 * contact before. Case-insensitive, null-safe (returns null for a
 * null/empty email rather than matching every dealer with a null
 * email). */
export function findDealerByEmail(email) {
  if (!email) return null;
  return selectByEmailStmt.get(email) || null;
}

export function dealerExists(id) {
  return existsStmt.get(id).n > 0;
}

/**
 * Generic updater — anything omitted from `patch` keeps its current
 * value. This IS how a dealer's status ever changes (including
 * pending -> verified) — always an explicit admin action via PATCH,
 * never automatic. Returns the updated row, or null if no dealer has
 * that id.
 */
export function updateDealerById(id, patch) {
  const existing = selectByIdStmt.get(id);
  if (!existing) return null;

  const merged = {
    id,
    companyName: patch.companyName !== undefined ? patch.companyName : existing.companyName,
    contactName: patch.contactName !== undefined ? patch.contactName : existing.contactName,
    email: patch.email !== undefined ? patch.email : existing.email,
    phone: patch.phone !== undefined ? patch.phone : existing.phone,
    city: patch.city !== undefined ? patch.city : existing.city,
    website: patch.website !== undefined ? patch.website : existing.website,
    status: patch.status !== undefined ? patch.status : existing.status,
    internalNote: patch.internalNote !== undefined ? patch.internalNote : existing.internalNote,
    updatedAt: new Date().toISOString()
  };

  updateStmt.run(merged);
  return findDealerById(id);
}

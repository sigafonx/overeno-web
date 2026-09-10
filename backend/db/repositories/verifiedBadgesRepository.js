import crypto from 'crypto';
import { db } from '../database.js';

export const BADGE_STATUSES = ['requested', 'approved', 'rejected', 'revoked', 'expired'];

// Statuses a vehicle can have an "active" badge in — used to block a
// second badge request while one is already live (see
// hasActiveBadgeForVehicle() below). Deliberately excludes rejected/
// revoked/expired: the dealer can request again if circumstances change.
const ACTIVE_BADGE_STATUSES = ['requested', 'approved'];

// Public, shareable code — NOT a secret like reports' publicToken (this
// is meant to be embedded on a dealer's own listing page), but still
// random enough that codes can't be guessed/enumerated. Avoids visually
// ambiguous characters (0/O, 1/I/L) since this is meant to be typed/
// read by humans, not just pasted as a URL.
const BADGE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BADGE_CODE_LENGTH = 10;

function generateBadgeCode() {
  const bytes = crypto.randomBytes(BADGE_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < BADGE_CODE_LENGTH; i++) {
    code += BADGE_CODE_ALPHABET[bytes[i] % BADGE_CODE_ALPHABET.length];
  }
  return code;
}

function generateBadgeId() {
  return 'badge_' + crypto.randomBytes(6).toString('hex');
}

const BADGE_COLUMNS = [
  'id', 'dealerId', 'vehicleId', 'status', 'badgeCode', 'issuedAt',
  'expiresAt', 'revokedAt', 'internalNote', 'createdAt', 'updatedAt'
];

const insertStmt = db.prepare(`
  INSERT INTO verified_badges (${BADGE_COLUMNS.join(', ')})
  VALUES (${BADGE_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM verified_badges');
const selectByIdStmt = db.prepare('SELECT * FROM verified_badges WHERE id = ?');
const selectByVehicleStmt = db.prepare('SELECT * FROM verified_badges WHERE vehicleId = ? ORDER BY createdAt DESC');
const selectByCodeStmt = db.prepare('SELECT * FROM verified_badges WHERE badgeCode = ?');
const updateStatusStmt = db.prepare(`
  UPDATE verified_badges
  SET status = @status, issuedAt = @issuedAt, expiresAt = @expiresAt,
      revokedAt = @revokedAt, internalNote = @internalNote, updatedAt = @updatedAt
  WHERE id = @id
`);

/**
 * Lazily transitions an 'approved' badge to 'expired' the moment
 * expiresAt has passed — checked (and, if needed, persisted) every time
 * a badge is read, so there's no background job/cron needed and the
 * stored status is never stale by more than the time since the last
 * read. Every read function below (findById/findByCode/findAll) routes
 * through this, so 'expired' is always accurate wherever a badge shows
 * up — admin list, admin detail, or the public badge page.
 */
function withLazyExpiry(badge) {
  if (!badge) return badge;
  if (badge.status === 'approved' && badge.expiresAt && new Date(badge.expiresAt).getTime() < Date.now()) {
    const now = new Date().toISOString();
    updateStatusStmt.run({
      id: badge.id,
      status: 'expired',
      issuedAt: badge.issuedAt,
      expiresAt: badge.expiresAt,
      revokedAt: badge.revokedAt,
      internalNote: badge.internalNote,
      updatedAt: now
    });
    return { ...badge, status: 'expired', updatedAt: now };
  }
  return badge;
}

/**
 * Creates a badge REQUEST — always status='requested', badgeCode
 * generated immediately (stable identifier from the start, but the
 * public page — see server.js's GET /badges/public/:badgeCode — will
 * honestly show "requested" until an admin actually approves it; the
 * code existing is not itself a promise of anything). Caller (see
 * server.js) is responsible for the "does this vehicle already have an
 * active request" check via hasActiveBadgeForVehicle() below, and for
 * confirming the dealer is verified, BEFORE calling this.
 */
export function createBadgeRequest({ dealerId, vehicleId, internalNote }) {
  const now = new Date().toISOString();
  const badge = {
    id: generateBadgeId(),
    dealerId,
    vehicleId,
    status: 'requested',
    badgeCode: generateBadgeCode(),
    issuedAt: null,
    expiresAt: null,
    revokedAt: null,
    internalNote: internalNote ?? null,
    createdAt: now,
    updatedAt: now
  };
  insertStmt.run(badge);
  return getBadgeById(badge.id);
}

export function getBadgeById(id) {
  return withLazyExpiry(selectByIdStmt.get(id) || null);
}

export function getBadgeByCode(badgeCode) {
  return withLazyExpiry(selectByCodeStmt.get(badgeCode) || null);
}

export function listBadgesForVehicle(vehicleId) {
  return selectByVehicleStmt.all(vehicleId).map(withLazyExpiry);
}

/** True if this vehicle currently has a 'requested' or 'approved' badge
 * — used to block a duplicate/overlapping request. A vehicle whose only
 * badges are rejected/revoked/expired is free to request again. */
export function hasActiveBadgeForVehicle(vehicleId) {
  return listBadgesForVehicle(vehicleId).some((b) => ACTIVE_BADGE_STATUSES.includes(b.status));
}

function filterBadgeRows(filters) {
  let badges = selectAllStmt.all().map(withLazyExpiry).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filters.status) badges = badges.filter((b) => b.status === filters.status);
  if (filters.dealerId) badges = badges.filter((b) => b.dealerId === filters.dealerId);
  if (filters.vehicleId) badges = badges.filter((b) => b.vehicleId === filters.vehicleId);
  if (filters.search) {
    const q = String(filters.search).trim().toLowerCase();
    badges = badges.filter((b) =>
      (b.id || '').toLowerCase().includes(q) ||
      (b.badgeCode || '').toLowerCase().includes(q) ||
      (b.dealerId || '').toLowerCase().includes(q) ||
      (b.vehicleId || '').toLowerCase().includes(q)
    );
  }

  return badges;
}

/** Paginated list (max 200 per call). For CSV export, where every
 * matching row is needed, use listAllMatchingBadges() instead. */
export function listBadges(filters = {}) {
  const badges = filterBadgeRows(filters);

  const total = badges.length;
  const offset = Math.max(0, parseInt(filters.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit, 10) || 50));
  return { items: badges.slice(offset, offset + limit), total };
}

export function listAllMatchingBadges(filters = {}) {
  return filterBadgeRows(filters);
}

/**
 * Transitions a badge's status — this is the ONLY function that can
 * move a badge to 'approved' (setting issuedAt + expiresAt, defaulting
 * expiresAt to 365 days out if the caller doesn't provide one) or
 * 'revoked' (setting revokedAt, once). Called exclusively from an
 * explicit admin PATCH — see server.js's own comment on why that's the
 * enforcement point for "badge выдаёт только админ". Returns the
 * updated row, or null if no badge has that id.
 */
export function updateBadgeStatus(id, { status, expiresAt, internalNote }) {
  const existing = getBadgeById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const merged = {
    id,
    status,
    issuedAt: existing.issuedAt,
    expiresAt: existing.expiresAt,
    revokedAt: existing.revokedAt,
    internalNote: internalNote !== undefined ? internalNote : existing.internalNote,
    updatedAt: now
  };

  if (status === 'approved' && !existing.issuedAt) {
    merged.issuedAt = now;
    merged.expiresAt = expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  } else if (status === 'approved' && expiresAt !== undefined) {
    // Re-approving / extending an already-approved badge — allow the
    // admin to explicitly push expiresAt out without touching issuedAt.
    merged.expiresAt = expiresAt;
  }
  if (status === 'revoked' && !existing.revokedAt) {
    merged.revokedAt = now;
  }

  updateStatusStmt.run(merged);
  return getBadgeById(id);
}

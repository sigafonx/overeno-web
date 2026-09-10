import { db } from '../database.js';

const BOOKING_COLUMNS = [
  'id', 'status', 'createdAt', 'updatedAt', 'vin', 'listingUrl', 'city',
  'preferredSlot', 'contactName', 'email', 'phone', 'language', 'source',
  'pageUrl', 'message', 'internalNote', 'paidAt', 'paymentId'
];

const insertStmt = db.prepare(`
  INSERT INTO bookings (${BOOKING_COLUMNS.join(', ')})
  VALUES (${BOOKING_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM bookings');
const selectByIdStmt = db.prepare('SELECT * FROM bookings WHERE id = ?');
const updateStatusStmt = db.prepare('UPDATE bookings SET status = ?, updatedAt = ? WHERE id = ?');
const updateNoteStmt = db.prepare('UPDATE bookings SET internalNote = ?, updatedAt = ? WHERE id = ?');
const markPaidStmt = db.prepare('UPDATE bookings SET status = ?, paidAt = ?, paymentId = ?, updatedAt = ? WHERE id = ?');
const updateAssignedAgentStmt = db.prepare('UPDATE bookings SET assignedAgentId = ?, updatedAt = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM bookings WHERE id = ?');
const existsStmt = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE id = ?');

function toParams(booking) {
  const params = {};
  for (const col of BOOKING_COLUMNS) {
    params[col] = booking[col] !== undefined ? booking[col] : null;
  }
  return params;
}

/** Inserts a booking (same shape POST /bookings has always built) and returns it as-is. */
export function insertBooking(booking) {
  insertStmt.run(toParams(booking));
  return booking;
}

/** Every booking, unfiltered/unsorted — callers keep doing filter/sort/paginate in JS, unchanged. */
export function findAllBookings() {
  return selectAllStmt.all();
}

export function findBookingById(id) {
  return selectByIdStmt.get(id) || null;
}

export function updateBookingStatusById(id, status) {
  const updatedAt = new Date().toISOString();
  const info = updateStatusStmt.run(status, updatedAt, id);
  if (info.changes === 0) return null;
  return findBookingById(id);
}

export function updateBookingNoteById(id, internalNote) {
  const updatedAt = new Date().toISOString();
  const info = updateNoteStmt.run(internalNote, updatedAt, id);
  if (info.changes === 0) return null;
  return findBookingById(id);
}

/** Called by paymentService.js when a payment for this booking clears —
 * sets status='paid' plus paidAt/paymentId in one write. Not idempotency-
 * aware itself; the caller (paymentService.applyWebhookEvent) is what
 * decides whether this should run at all for a given webhook. */
export function markBookingPaid(id, { paidAt, paymentId }) {
  const updatedAt = new Date().toISOString();
  const info = markPaidStmt.run('paid', paidAt, paymentId, updatedAt, id);
  if (info.changes === 0) return null;
  return findBookingById(id);
}

export function deleteBookingByIdRepo(id) {
  const info = deleteStmt.run(id);
  return info.changes > 0;
}

export function bookingExists(id) {
  return existsStmt.get(id).n > 0;
}

/** assignedAgentId may be a real id or null (to unassign). Returns the
 * updated booking, or null if no booking has that id. */
export function updateBookingAssignedAgentById(id, assignedAgentId) {
  const updatedAt = new Date().toISOString();
  const info = updateAssignedAgentStmt.run(assignedAgentId, updatedAt, id);
  if (info.changes === 0) return null;
  return findBookingById(id);
}

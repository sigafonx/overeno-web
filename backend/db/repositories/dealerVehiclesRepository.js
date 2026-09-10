import crypto from 'crypto';
import { db } from '../database.js';

// Vehicle's own listing lifecycle — independent from any badge's status
// (a vehicle can be 'active' while its badge is 'revoked', or 'sold'
// while an old badge is still 'approved' until it expires). Not part
// of this step's literal spec (only dealer/badge statuses were given)
// but a vehicle record needs *some* lifecycle field, and this is
// documented here plus in backend/README.md's "Dealer workflow" section.
export const DEALER_VEHICLE_STATUSES = ['active', 'sold', 'archived'];

const VEHICLE_COLUMNS = [
  'id', 'dealerId', 'vin', 'make', 'model', 'year', 'listingUrl',
  'status', 'createdAt', 'updatedAt'
];

const insertStmt = db.prepare(`
  INSERT INTO dealer_vehicles (${VEHICLE_COLUMNS.join(', ')})
  VALUES (${VEHICLE_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM dealer_vehicles');
const selectByIdStmt = db.prepare('SELECT * FROM dealer_vehicles WHERE id = ?');
const existsStmt = db.prepare('SELECT COUNT(*) AS n FROM dealer_vehicles WHERE id = ?');
const updateStmt = db.prepare(`
  UPDATE dealer_vehicles
  SET vin = @vin, make = @make, model = @model, year = @year,
      listingUrl = @listingUrl, status = @status, updatedAt = @updatedAt
  WHERE id = @id
`);

function generateVehicleId() {
  return 'dealervehicle_' + crypto.randomBytes(6).toString('hex');
}

export function insertDealerVehicle(data) {
  const now = new Date().toISOString();
  const vehicle = {
    id: data.id || generateVehicleId(),
    dealerId: data.dealerId,
    vin: data.vin ?? null,
    make: data.make ?? null,
    model: data.model ?? null,
    year: data.year ?? null,
    listingUrl: data.listingUrl ?? null,
    status: data.status || 'active',
    createdAt: now,
    updatedAt: now
  };
  insertStmt.run(vehicle);
  return findDealerVehicleById(vehicle.id);
}

export function findAllDealerVehicles() {
  return selectAllStmt.all();
}

export function findDealerVehicleById(id) {
  return selectByIdStmt.get(id) || null;
}

export function dealerVehicleExists(id) {
  return existsStmt.get(id).n > 0;
}

/** Generic updater — anything omitted from `patch` keeps its current
 * value. Note dealerId is deliberately NOT editable here — a vehicle
 * doesn't change owners through this endpoint; re-create it under the
 * correct dealer instead if that's genuinely needed. Returns the
 * updated row, or null if no vehicle has that id. */
export function updateDealerVehicleById(id, patch) {
  const existing = selectByIdStmt.get(id);
  if (!existing) return null;

  const merged = {
    id,
    vin: patch.vin !== undefined ? patch.vin : existing.vin,
    make: patch.make !== undefined ? patch.make : existing.make,
    model: patch.model !== undefined ? patch.model : existing.model,
    year: patch.year !== undefined ? patch.year : existing.year,
    listingUrl: patch.listingUrl !== undefined ? patch.listingUrl : existing.listingUrl,
    status: patch.status !== undefined ? patch.status : existing.status,
    updatedAt: new Date().toISOString()
  };

  updateStmt.run(merged);
  return findDealerVehicleById(id);
}

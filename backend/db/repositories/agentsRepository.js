import { db } from '../database.js';

export const AGENT_ROLES = ['sales_agent', 'booking_coordinator', 'vin_analyst', 'payment_admin', 'admin_supervisor'];

const AGENT_COLUMNS = ['id', 'name', 'role', 'email', 'active', 'createdAt', 'updatedAt'];

const insertStmt = db.prepare(`
  INSERT INTO agents (${AGENT_COLUMNS.join(', ')})
  VALUES (${AGENT_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM agents');
const selectByIdStmt = db.prepare('SELECT * FROM agents WHERE id = ?');
const existsStmt = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE id = ?');
const updateStmt = db.prepare(`
  UPDATE agents
  SET name = @name, role = @role, email = @email, active = @active, updatedAt = @updatedAt
  WHERE id = @id
`);

/** SQLite has no boolean type — active is stored as 0/1, this converts
 * back to a real boolean for anything reading the API response. */
function nestRow(row) {
  if (!row) return null;
  return { ...row, active: !!row.active };
}

export function insertAgent(agent) {
  insertStmt.run({ ...agent, active: agent.active ? 1 : 0 });
  return nestRow({ ...agent, active: agent.active ? 1 : 0 });
}

/** Every agent, unfiltered/unsorted — the admin route does filter/sort/paginate in JS. */
export function findAllAgents() {
  return selectAllStmt.all().map(nestRow);
}

export function findAgentById(id) {
  return nestRow(selectByIdStmt.get(id));
}

export function agentExists(id) {
  return existsStmt.get(id).n > 0;
}

/**
 * Generic updater for name/role/email/active — anything omitted from
 * `patch` keeps its current value. Returns the updated row, or null if no
 * agent has that id.
 */
export function updateAgentById(id, patch) {
  const existing = selectByIdStmt.get(id);
  if (!existing) return null;

  const merged = {
    id,
    name: patch.name !== undefined ? patch.name : existing.name,
    role: patch.role !== undefined ? patch.role : existing.role,
    email: patch.email !== undefined ? patch.email : existing.email,
    active: patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active,
    updatedAt: new Date().toISOString()
  };

  updateStmt.run(merged);
  return findAgentById(id);
}

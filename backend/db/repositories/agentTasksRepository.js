import crypto from 'crypto';
import { db } from '../database.js';

export const AGENT_TASK_STATUSES = ['open', 'reviewed', 'completed', 'dismissed'];

const INSERT_COLUMNS = [
  'id', 'agentName', 'entityType', 'entityId', 'taskType', 'title',
  'description', 'suggestedAction', 'suggestedMessage', 'status',
  'createdAt', 'updatedAt'
];

const insertStmt = db.prepare(`
  INSERT INTO agent_tasks (${INSERT_COLUMNS.join(', ')})
  VALUES (${INSERT_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM agent_tasks');
const selectByIdStmt = db.prepare('SELECT * FROM agent_tasks WHERE id = ?');
const updateStatusStmt = db.prepare(`
  UPDATE agent_tasks
  SET status = @status, reviewedAt = @reviewedAt, completedAt = @completedAt, updatedAt = @updatedAt
  WHERE id = @id
`);

function generateTaskId() {
  return 'agenttask_' + crypto.randomBytes(6).toString('hex');
}

/** Creates one task row — always status='open'. Callers (see
 * backend/ai/businessAgentRunner.js) typically create several of these
 * in one go, one per suggestion an agent produced, since a single agent
 * run can suggest more than one distinct next step. */
export function createAgentTask(data) {
  const now = new Date().toISOString();
  const task = {
    id: data.id || generateTaskId(),
    agentName: data.agentName,
    entityType: data.entityType,
    entityId: data.entityId,
    taskType: data.taskType,
    title: data.title,
    description: data.description ?? null,
    suggestedAction: data.suggestedAction ?? null,
    suggestedMessage: data.suggestedMessage ?? null,
    status: 'open',
    createdAt: now,
    updatedAt: now
  };
  insertStmt.run(task);
  return getAgentTaskById(task.id);
}

export function getAgentTaskById(id) {
  return selectByIdStmt.get(id) || null;
}

function filterAgentTaskRows(filters) {
  let tasks = selectAllStmt.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filters.agentName) tasks = tasks.filter((t) => t.agentName === filters.agentName);
  if (filters.status) tasks = tasks.filter((t) => t.status === filters.status);
  if (filters.entityType) tasks = tasks.filter((t) => t.entityType === filters.entityType);
  if (filters.taskType) tasks = tasks.filter((t) => t.taskType === filters.taskType);
  if (filters.entityId) tasks = tasks.filter((t) => t.entityId === filters.entityId);
  if (filters.search) {
    const q = String(filters.search).trim().toLowerCase();
    tasks = tasks.filter((t) =>
      (t.id || '').toLowerCase().includes(q) ||
      (t.entityId || '').toLowerCase().includes(q) ||
      (t.title || '').toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q)
    );
  }

  return tasks;
}

/** Paginated list (max 200 per call) — same filter/paginate pattern used
 * throughout this backend (see reportsRepository.js's listReports()).
 * For CSV export, where every matching row is needed, use
 * listAllMatchingAgentTasks() instead. */
export function listAgentTasks(filters = {}) {
  const tasks = filterAgentTaskRows(filters);

  const total = tasks.length;
  const offset = Math.max(0, parseInt(filters.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit, 10) || 50));
  const items = tasks.slice(offset, offset + limit);

  return { items, total };
}

export function listAllMatchingAgentTasks(filters = {}) {
  return filterAgentTaskRows(filters);
}

/**
 * Transitions a task's status. Sets `reviewedAt` the first time the
 * task moves to anything other than 'open' (reviewed, completed, or
 * dismissed all count as "a human looked at this"), and `completedAt`
 * specifically when it becomes 'completed'. Neither timestamp is ever
 * overwritten once set — mirrors the "first time only" timestamp
 * pattern used for paidAt/cancelledAt elsewhere in this backend.
 * Returns the updated row, or null if no task has that id.
 */
export function updateAgentTaskStatus(id, status) {
  const existing = getAgentTaskById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const merged = {
    id,
    status,
    reviewedAt: status !== 'open' && !existing.reviewedAt ? now : existing.reviewedAt,
    completedAt: status === 'completed' && !existing.completedAt ? now : existing.completedAt,
    updatedAt: now
  };
  updateStatusStmt.run(merged);
  return getAgentTaskById(id);
}

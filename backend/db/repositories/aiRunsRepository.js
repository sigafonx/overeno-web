import crypto from 'crypto';
import { db } from '../database.js';

export const AI_RUN_STATUSES = ['running', 'completed', 'failed'];

const AI_RUN_INSERT_COLUMNS = [
  'id', 'agentName', 'entityType', 'entityId', 'status', 'inputJson',
  'model', 'provider', 'requiresHumanReview', 'createdAt', 'updatedAt'
];

const insertStmt = db.prepare(`
  INSERT INTO ai_agent_runs (${AI_RUN_INSERT_COLUMNS.join(', ')})
  VALUES (${AI_RUN_INSERT_COLUMNS.map((c) => '@' + c).join(', ')})
`);
const selectAllStmt = db.prepare('SELECT * FROM ai_agent_runs');
const selectByIdStmt = db.prepare('SELECT * FROM ai_agent_runs WHERE id = ?');
const updateResultStmt = db.prepare(`
  UPDATE ai_agent_runs
  SET status = @status, outputJson = @outputJson, errorMessage = @errorMessage,
      estimatedCost = @estimatedCost, model = @model, updatedAt = @updatedAt
  WHERE id = @id
`);
const updateReviewStmt = db.prepare(`
  UPDATE ai_agent_runs
  SET reviewedAt = @reviewedAt, approvedAt = @approvedAt, rejectedAt = @rejectedAt,
      reviewNote = @reviewNote, updatedAt = @updatedAt
  WHERE id = @id
`);
const markAppliedStmt = db.prepare('UPDATE ai_agent_runs SET appliedAt = ?, updatedAt = ? WHERE id = ?');

function generateRunId() {
  return 'airun_' + crypto.randomBytes(6).toString('hex');
}

/** Creates a run row with status='running' — the orchestrator calls this
 * BEFORE calling the provider, so even a run that crashes mid-flight
 * (process killed, unexpected exception) leaves a visible trail instead
 * of vanishing silently. Returns the created row. */
export function insertAiRun(data) {
  const now = new Date().toISOString();
  const run = {
    id: data.id || generateRunId(),
    agentName: data.agentName,
    entityType: data.entityType,
    entityId: data.entityId,
    status: 'running',
    inputJson: data.inputJson ?? null,
    model: data.model ?? null,
    provider: data.provider ?? null,
    requiresHumanReview: data.requiresHumanReview ? 1 : 0,
    createdAt: now,
    updatedAt: now
  };
  insertStmt.run(run);
  return getAiRunById(run.id);
}

/** Transitions a run to its final state — 'completed' with outputJson/
 * estimatedCost/model, or 'failed' with errorMessage. `model` is
 * deliberately re-settable here (not just at insertAiRun() time): the
 * insert-time value only reflects the generic AI_MODEL env var, which is
 * often empty (e.g. AI_PROVIDER=openai uses its own OPENAI_MODEL
 * instead) — the provider's own actual reported model (see
 * aiClient.js's runWithProvider()) is the more accurate value once a run
 * completes, so this updates it in place rather than trusting the
 * insert-time guess. Returns the updated row, or null if no run has that
 * id. */
export function updateAiRunResult(id, patch) {
  const existing = getAiRunById(id);
  if (!existing) return null;

  const merged = {
    id,
    status: patch.status,
    outputJson: patch.outputJson !== undefined ? patch.outputJson : existing.outputJson,
    errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
    estimatedCost: patch.estimatedCost !== undefined ? patch.estimatedCost : existing.estimatedCost,
    model: patch.model !== undefined ? patch.model : existing.model,
    updatedAt: new Date().toISOString()
  };
  updateResultStmt.run(merged);
  return getAiRunById(id);
}

export function getAiRunById(id) {
  return selectByIdStmt.get(id) || null;
}

function filterAiRunRows(filters) {
  let runs = selectAllStmt.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filters.agentName) runs = runs.filter((r) => r.agentName === filters.agentName);
  if (filters.status) runs = runs.filter((r) => r.status === filters.status);
  if (filters.entityType) runs = runs.filter((r) => r.entityType === filters.entityType);
  if (filters.entityId) runs = runs.filter((r) => r.entityId === filters.entityId);
  if (filters.search) {
    const q = String(filters.search).trim().toLowerCase();
    runs = runs.filter((r) =>
      (r.id || '').toLowerCase().includes(q) ||
      (r.agentName || '').toLowerCase().includes(q) ||
      (r.entityId || '').toLowerCase().includes(q) ||
      (r.errorMessage || '').toLowerCase().includes(q)
    );
  }

  return runs;
}

/** Paginated list (max 200 per call) — same filter/paginate pattern as
 * reportsRepository.js's listReports(). For CSV export, where every
 * matching row is needed, use listAllMatchingAiRuns() instead. */
export function listAiRuns(filters = {}) {
  const runs = filterAiRunRows(filters);

  const total = runs.length;
  const offset = Math.max(0, parseInt(filters.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit, 10) || 50));
  const items = runs.slice(offset, offset + limit);

  return { items, total };
}

export function listAllMatchingAiRuns(filters = {}) {
  return filterAiRunRows(filters);
}

/**
 * Records a human review decision. Always sets reviewedAt; sets EXACTLY
 * ONE of approvedAt/rejectedAt depending on `approved` (the other stays
 * whatever it was — normally null, since a run is only reviewed once in
 * this step's scope, but re-reviewing isn't blocked, just not a
 * scenario this step builds a UI affordance for). Returns the updated
 * row, or null if no run has that id.
 */
export function updateAiRunReview(id, { approved, reviewNote }) {
  const existing = getAiRunById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const merged = {
    id,
    reviewedAt: now,
    approvedAt: approved ? now : existing.approvedAt,
    rejectedAt: approved === false ? now : existing.rejectedAt,
    reviewNote: reviewNote !== undefined ? reviewNote : existing.reviewNote,
    updatedAt: now
  };
  updateReviewStmt.run(merged);
  return getAiRunById(id);
}

/** Records that an approved run's output was applied to its report (see
 * backend/ai/applyToReport.js). Does NOT overwrite an existing
 * appliedAt — re-applying an already-applied run is allowed by the
 * route handler (it's not destructive, sections just get overwritten/
 * appended again), but the "first applied" timestamp is preserved so
 * the admin UI can show "applied on <date>" meaningfully. Returns the
 * updated row, or null if no run has that id. */
export function markAiRunApplied(id) {
  const existing = getAiRunById(id);
  if (!existing) return null;
  if (existing.appliedAt) return existing;

  const now = new Date().toISOString();
  markAppliedStmt.run(now, now, id);
  return getAiRunById(id);
}

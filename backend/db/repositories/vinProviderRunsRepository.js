import crypto from 'crypto';
import { db } from '../database.js';

export const VIN_PROVIDER_RUN_STATUSES = ['running', 'completed', 'failed'];

const insertStmt = db.prepare(`
  INSERT INTO vin_provider_runs (id, vinCheckId, provider, status, requestJson, createdAt, updatedAt)
  VALUES (@id, @vinCheckId, @provider, @status, @requestJson, @createdAt, @updatedAt)
`);
const selectByIdStmt = db.prepare('SELECT * FROM vin_provider_runs WHERE id = ?');
const selectByVinCheckStmt = db.prepare('SELECT * FROM vin_provider_runs WHERE vinCheckId = ? ORDER BY createdAt DESC');
const updateResultStmt = db.prepare(`
  UPDATE vin_provider_runs
  SET status = @status, responseJson = @responseJson, normalizedJson = @normalizedJson,
      costEstimate = @costEstimate, errorMessage = @errorMessage, updatedAt = @updatedAt
  WHERE id = @id
`);

function generateRunId() {
  return 'vinrun_' + crypto.randomBytes(6).toString('hex');
}

/** Creates a run row with status='running' BEFORE the provider is ever
 * called — mirrors ai_agent_runs' own insert-then-update pattern (see
 * backend/ai/orchestrator.js) — so even a crash mid-call, or a real
 * provider timing out, leaves a visible audit trail instead of a
 * request that just vanished. Returns the created row. */
export function insertVinProviderRun({ vinCheckId, provider, requestJson }) {
  const now = new Date().toISOString();
  const run = {
    id: generateRunId(),
    vinCheckId,
    provider,
    status: 'running',
    requestJson: requestJson ?? null,
    createdAt: now,
    updatedAt: now
  };
  insertStmt.run(run);
  return getVinProviderRunById(run.id);
}

/** Transitions a run to its final state — 'completed' with
 * responseJson/normalizedJson/costEstimate, or 'failed' with
 * errorMessage. Returns the updated row, or null if no run has that id. */
export function updateVinProviderRunResult(id, patch) {
  const existing = getVinProviderRunById(id);
  if (!existing) return null;

  const merged = {
    id,
    status: patch.status,
    responseJson: patch.responseJson !== undefined ? patch.responseJson : existing.responseJson,
    normalizedJson: patch.normalizedJson !== undefined ? patch.normalizedJson : existing.normalizedJson,
    costEstimate: patch.costEstimate !== undefined ? patch.costEstimate : existing.costEstimate,
    errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
    updatedAt: new Date().toISOString()
  };
  updateResultStmt.run(merged);
  return getVinProviderRunById(id);
}

export function getVinProviderRunById(id) {
  return selectByIdStmt.get(id) || null;
}

/** All runs for one vin_check, most recent first — used by the admin UI
 * to show the run history under a VIN check's detail. */
export function listVinProviderRunsForVinCheck(vinCheckId) {
  return selectByVinCheckStmt.all(vinCheckId);
}

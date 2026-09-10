import crypto from 'crypto';
import { db } from '../database.js';

const insertStmt = db.prepare(`
  INSERT INTO ai_prompts (id, agentName, promptVersion, promptText, active, createdAt)
  VALUES (@id, @agentName, @promptVersion, @promptText, @active, @createdAt)
`);
const selectActiveByAgentStmt = db.prepare('SELECT * FROM ai_prompts WHERE agentName = ? AND active = 1 ORDER BY createdAt DESC LIMIT 1');
const selectAllByAgentStmt = db.prepare('SELECT * FROM ai_prompts WHERE agentName = ? ORDER BY createdAt DESC');

function generatePromptId() {
  return 'aiprompt_' + crypto.randomBytes(6).toString('hex');
}

/** Returns the currently-active prompt template row for an agent, or
 * null if none has been seeded yet (see orchestrator.js's
 * seedPromptsIfNeeded(), called once at server startup). */
export function getActivePrompt(agentName) {
  return selectActiveByAgentStmt.get(agentName) || null;
}

export function listPromptsForAgent(agentName) {
  return selectAllByAgentStmt.all(agentName);
}

/** Inserts a new prompt template row. Does NOT deactivate any existing
 * active row for the same agent — this step only ever seeds one version
 * per agent once (see seedPromptsIfNeeded()), so there's no version-
 * switching UI yet to need that. Returns the created row. */
export function insertPrompt({ agentName, promptVersion, promptText, active }) {
  const row = {
    id: generatePromptId(),
    agentName,
    promptVersion,
    promptText,
    active: active ? 1 : 0,
    createdAt: new Date().toISOString()
  };
  insertStmt.run(row);
  return row;
}

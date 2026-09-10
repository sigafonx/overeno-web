import { AI_ENABLED, AI_MAX_INPUT_CHARS, AI_MODEL } from './aiConfig.js';
import { getAgentDefinition, ALLOWED_AGENT_NAMES, isAgentAllowedForEntityType } from './agentRegistry.js';
import { runWithProvider, getAiProvider } from './aiClient.js';
import { validateAgentInputSize, validateAgentInputShape, containsSuspiciousSecret, validateAgentOutputShape } from './safety/aiGuards.js';
import { PROMPT_BUILDERS } from './prompts/reportPrompts.js';
import { buildReportContext } from './reportContext.js';
import { insertAiRun, updateAiRunResult } from '../db/repositories/aiRunsRepository.js';
import { getActivePrompt, insertPrompt } from '../db/repositories/aiPromptsRepository.js';

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validates a POST /admin/ai/run payload BEFORE anything is persisted or
 * any provider is touched — returns an array of human-readable problem
 * strings (empty = valid). Deliberately does NOT check AI_ENABLED here;
 * that's a separate, higher-priority gate checked first in runAgent()
 * below, so a disabled-AI response and a bad-payload response are never
 * confused with each other.
 *
 * `input` is OPTIONAL when entityType is "report" — omitting it means
 * "auto-gather the report's own context" (see runAgent() below). It's
 * still validated here IF present, same as before.
 */
export function validateRunRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }

  const problems = [];
  const agentName = str(payload.agentName);
  const entityType = str(payload.entityType);
  const entityId = str(payload.entityId);

  if (!agentName) {
    problems.push('agentName is required.');
  } else if (!ALLOWED_AGENT_NAMES.includes(agentName)) {
    problems.push(`agentName must be one of: ${ALLOWED_AGENT_NAMES.join(', ')}.`);
  }

  if (!entityType) {
    problems.push('entityType is required.');
  } else if (agentName && ALLOWED_AGENT_NAMES.includes(agentName) && !isAgentAllowedForEntityType(agentName, entityType)) {
    const def = getAgentDefinition(agentName);
    problems.push(`agent "${agentName}" does not support entityType "${entityType}" — allowed: ${def.entityTypes.join(', ')}.`);
  }

  if (!entityId) {
    problems.push('entityId is required.');
  }

  if (payload.input !== undefined) {
    const shapeProblems = validateAgentInputShape(payload.input);
    problems.push(...shapeProblems);
    if (shapeProblems.length === 0) {
      problems.push(...validateAgentInputSize(payload.input, AI_MAX_INPUT_CHARS));
    }
    if (containsSuspiciousSecret(payload.input)) {
      problems.push('input appears to contain a secret/API key — remove it before submitting. This is never sent anywhere in this step (AI_PROVIDER=mock), but the check stays on regardless so it is already in place once a real provider is added.');
    }
  }

  return problems;
}

/**
 * Runs one AI agent end-to-end: resolves the effective input (auto-
 * gathering report context if none was provided — see below), persists
 * a `running` row first (so even an unexpected crash mid-call leaves a
 * visible trail), calls the configured provider, validates the output
 * shape, then persists the final `completed`/`failed` state. Throws
 * with a `.code` on failure (AI_DISABLED, PROVIDER_NOT_CONFIGURED,
 * VALIDATION_ERROR, or INVALID_OUTPUT) — the route handler in server.js
 * maps `.code` to an HTTP status, same pattern as
 * paymentService.createCheckout().
 *
 * requiresHumanReview is HARD-CODED to true here, not read from
 * AI_REQUIRE_HUMAN_REVIEW — see aiConfig.js's comment on that flag for
 * why. Every single run this step can produce requires a human admin to
 * approve or reject it before its content is used anywhere else — see
 * applyToReport.js for the one and only place approved output can reach
 * a report, and it re-checks approval itself, independent of this flag.
 */
export async function runAgent({ agentName, entityType, entityId, input }) {
  if (!AI_ENABLED) {
    const err = new Error('AI features are currently disabled (AI_ENABLED=false).');
    err.code = 'AI_DISABLED';
    throw err;
  }

  const def = getAgentDefinition(agentName);
  if (!def) {
    const err = new Error(`Unknown agentName "${agentName}".`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // Auto-gather report context when the caller didn't supply input and
  // this is a report-linked run — this is what lets admin-reports.html's
  // "Run" button work with zero manual JSON typing. Any explicitly
  // supplied `input` (even {}) is respected as-is and never overridden.
  let effectiveInput = input;
  if ((effectiveInput === undefined || effectiveInput === null) && entityType === 'report') {
    effectiveInput = buildReportContext(entityId);
    if (!effectiveInput) {
      const err = new Error(`Report "${entityId}" not found — cannot auto-gather context for it.`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
  }
  effectiveInput = effectiveInput || {};

  const provider = getAiProvider();
  const inputJson = JSON.stringify(effectiveInput);

  const run = insertAiRun({
    agentName,
    entityType,
    entityId,
    inputJson,
    model: AI_MODEL || null,
    provider: provider.getProviderName(),
    requiresHumanReview: true
  });

  try {
    const promptBuilder = PROMPT_BUILDERS[agentName];
    const prompt = promptBuilder(effectiveInput);
    const result = await runWithProvider({ agentName, prompt, input: effectiveInput });

    const outputProblems = validateAgentOutputShape(agentName, result.output);
    if (outputProblems.length > 0) {
      const err = new Error(`Provider returned output that doesn't match the expected shape for "${agentName}": ${outputProblems.join(' ')}`);
      err.code = 'INVALID_OUTPUT';
      throw err;
    }

    return updateAiRunResult(run.id, {
      status: 'completed',
      outputJson: JSON.stringify(result.output),
      estimatedCost: result.estimatedCost,
      model: result.model
    });
  } catch (err) {
    updateAiRunResult(run.id, { status: 'failed', errorMessage: err.message });
    throw err;
  }
}

/**
 * Seeds one static prompt-template row per agent, once — called at
 * server startup (see server.js). Uses each agent's prompt builder with
 * an empty input ({}) to capture the static instructional text (no
 * per-run data interpolated), so `ai_prompts` reflects "what template
 * is currently active for this agent", independent of any specific
 * run's actual data. Safe to call on every startup: no-ops for any
 * agent that already has an active row.
 */
export function seedPromptsIfNeeded() {
  for (const agentName of ALLOWED_AGENT_NAMES) {
    if (getActivePrompt(agentName)) continue;

    const promptBuilder = PROMPT_BUILDERS[agentName];
    if (!promptBuilder) continue;

    const { system, user } = promptBuilder({});
    insertPrompt({
      agentName,
      promptVersion: 'v1',
      promptText: `SYSTEM:\n${system}\n\nUSER:\n${user}`,
      active: true
    });
  }
}

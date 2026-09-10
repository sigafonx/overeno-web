import { AI_ENABLED, AI_MAX_INPUT_CHARS } from './aiConfig.js';
import { getAgentDefinition, BUSINESS_AGENT_NAMES, isAgentAllowedForEntityType } from './agentRegistry.js';
import { runWithProvider } from './aiClient.js';
import { validateAgentInputSize, validateAgentInputShape, containsSuspiciousSecret, validateAgentOutputShape, validateBusinessTaskItems } from './safety/aiGuards.js';
import { BUSINESS_PROMPT_BUILDERS } from './prompts/businessPrompts.js';
import { buildBusinessContext } from './businessContext.js';
import { createAgentTask } from '../db/repositories/agentTasksRepository.js';

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validates a POST /admin/agents/run-business-agent payload BEFORE
 * anything is persisted or any provider is touched. Mirrors
 * orchestrator.js's validateRunRequest() for the wave-1 report agents,
 * scoped to the 4 wave-2 business agents specifically (a request naming
 * a wave-1 agent here is rejected — that flow only exists via
 * POST /admin/ai/run).
 */
export function validateBusinessRunRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request body must be a JSON object.'];
  }

  const problems = [];
  const agentName = str(payload.agentName);
  const entityType = str(payload.entityType);
  const entityId = str(payload.entityId);

  if (!agentName) {
    problems.push('agentName is required.');
  } else if (!BUSINESS_AGENT_NAMES.includes(agentName)) {
    problems.push(`agentName must be one of: ${BUSINESS_AGENT_NAMES.join(', ')}.`);
  }

  if (!entityType) {
    problems.push('entityType is required.');
  } else if (agentName && BUSINESS_AGENT_NAMES.includes(agentName) && !isAgentAllowedForEntityType(agentName, entityType)) {
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
      problems.push('input appears to contain a secret/API key — remove it before submitting.');
    }
  }

  return problems;
}

/**
 * Runs one wave-2 business agent end-to-end: resolves the effective
 * input (auto-gathering safe entity context if none was provided — see
 * backend/ai/businessContext.js), calls the mock provider, validates
 * the output shape (twice: the top-level { tasks } wrapper, then each
 * task item), then creates ONE agent_tasks ROW PER SUGGESTED TASK.
 *
 * Deliberately does NOT go through ai_agent_runs at all — wave-2 agents
 * have no "approve then apply" step the way wave-1 report agents do
 * (see applyToReport.js); the agent_tasks row's own status
 * (open -> reviewed -> completed/dismissed) IS the human-review
 * mechanism here. Nothing this function does ever touches a
 * lead/booking/payment/report directly, sends anything, or changes any
 * status outside agent_tasks itself.
 *
 * Throws with a `.code` on failure (AI_DISABLED, VALIDATION_ERROR,
 * PROVIDER_NOT_CONFIGURED, INVALID_OUTPUT) — the route handler in
 * server.js maps `.code` to an HTTP status.
 */
export async function runBusinessAgent({ agentName, entityType, entityId, input }) {
  if (!AI_ENABLED) {
    const err = new Error('AI features are currently disabled (AI_ENABLED=false).');
    err.code = 'AI_DISABLED';
    throw err;
  }

  const def = getAgentDefinition(agentName);
  if (!def || def.kind !== 'business') {
    const err = new Error(`Unknown business agentName "${agentName}".`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  let effectiveInput = input;
  if (effectiveInput === undefined || effectiveInput === null) {
    effectiveInput = buildBusinessContext(entityType, entityId);
    if (!effectiveInput) {
      const err = new Error(`Entity "${entityType}:${entityId}" not found — cannot auto-gather context for it.`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
  }
  effectiveInput = effectiveInput || {};

  const promptBuilder = BUSINESS_PROMPT_BUILDERS[agentName];
  const prompt = promptBuilder(effectiveInput);
  const result = await runWithProvider({ agentName, prompt, input: effectiveInput });

  const shapeProblems = validateAgentOutputShape(agentName, result.output);
  if (shapeProblems.length > 0) {
    const err = new Error(`Provider returned output that doesn't match the expected shape for "${agentName}": ${shapeProblems.join(' ')}`);
    err.code = 'INVALID_OUTPUT';
    throw err;
  }
  const taskProblems = validateBusinessTaskItems(result.output.tasks);
  if (taskProblems.length > 0) {
    const err = new Error(`Provider returned invalid task suggestions for "${agentName}": ${taskProblems.join(' ')}`);
    err.code = 'INVALID_OUTPUT';
    throw err;
  }

  return result.output.tasks.map((task) =>
    createAgentTask({
      agentName,
      entityType,
      entityId,
      taskType: task.taskType,
      title: task.title,
      description: task.description ?? null,
      suggestedAction: task.suggestedAction ?? null,
      suggestedMessage: task.suggestedMessage ?? null
    })
  );
}

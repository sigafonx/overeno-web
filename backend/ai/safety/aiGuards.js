// Safety/cost guards for AI runs — deliberately simple and conservative
// for this step. Every function here returns an array of human-readable
// problem strings (empty = OK), matching the validate*Payload() pattern
// already used throughout server.js, so these compose the same way.

/**
 * Rejects input that's too large BEFORE anything resembling an AI call
 * happens — this is the main cost control for this step: a real
 * provider bills roughly by input size, so capping it here caps worst-
 * case cost regardless of which provider is selected later. Measured as
 * JSON-stringified character length, matching how the orchestrator
 * actually serializes `input` into the prompt.
 */
export function validateAgentInputSize(input, maxChars) {
  let json;
  try {
    json = JSON.stringify(input === undefined ? null : input);
  } catch {
    return ['input could not be serialized to JSON.'];
  }

  if (json.length > maxChars) {
    return [`input is too large: ${json.length} characters, max is ${maxChars}. Trim the input and try again.`];
  }
  return [];
}

/** input must be a plain JSON object (or omitted, defaulting to {}) —
 * never an array, string, or primitive, so every agent's prompt builder
 * can rely on a consistent shape. */
export function validateAgentInputShape(input) {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    return ['input must be a JSON object (or omitted).'];
  }
  return [];
}

/**
 * Best-effort, conservative check for what looks like a pasted secret
 * (API key, password, token) accidentally included in the input — this
 * step doesn't have a real provider actually sending data anywhere yet,
 * but the guard is here now so it's already in place once one is added.
 * Deliberately narrow (a few common key-prefix patterns) rather than a
 * broad heuristic that would false-positive constantly on legitimate
 * VIN/listing text.
 */
const SUSPICIOUS_SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/, // OpenAI-style secret key
  /sk_(test|live)_[a-zA-Z0-9]{10,}/, // Stripe-style secret key
  /whsec_[a-zA-Z0-9]{10,}/, // Stripe webhook secret
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/ // PEM private key block
];

export function containsSuspiciousSecret(input) {
  let json;
  try {
    json = JSON.stringify(input || {});
  } catch {
    return false;
  }
  return SUSPICIOUS_SECRET_PATTERNS.some((pattern) => pattern.test(json));
}

// ---------------------------------------------------------------------------
// Structured output validation — every agent in this wave must return a
// JSON object with these exact top-level keys (see backend/README.md's
// "AI agents — wave 1" section for the full shape of each, matching this
// step's spec). Used by orchestrator.js right after the provider call:
// output that doesn't match is treated as a FAILED run, not silently
// accepted — this is what makes "invalid output handled" a real
// guarantee rather than an assumption.
// ---------------------------------------------------------------------------

export const AGENT_OUTPUT_SCHEMAS = {
  listing_analysis: ['redFlags', 'missingInfo', 'sellerQuestions', 'confidence', 'summary'],
  risk_scoring: ['score', 'riskLevel', 'riskFactors', 'protectiveFactors', 'explanation'],
  report_writer: ['sections', 'summary', 'verdict'],
  buyer_advisor: ['recommendation', 'nextSteps', 'negotiationPoints', 'questionsForSeller'],
  vin_risk_explanation: ['vinSummary', 'riskExplanation', 'limitations'],
  // Wave 2 business agents all share the same output shape — a list of
  // suggested tasks (see businessAgentRunner.js, which turns each item
  // in `tasks` into its own agent_tasks row).
  crm_follow_up: ['tasks'],
  b2b_sales: ['tasks'],
  support: ['tasks'],
  operations_payment: ['tasks']
};

/**
 * Validates that a provider's output matches the required shape for
 * `agentName`. Deliberately checks only "the required keys are present"
 * (not exhaustive type-checking of every field) — good enough to catch
 * a genuinely broken/truncated response (e.g. a real model returning
 * prose instead of JSON, or a parse failure) without being so strict
 * that a reasonable model response gets rejected over a minor shape
 * difference. Returns an array of problem strings; empty = valid.
 */
export function validateAgentOutputShape(agentName, output) {
  const requiredKeys = AGENT_OUTPUT_SCHEMAS[agentName];
  if (!requiredKeys) {
    return [`No output schema registered for agent "${agentName}".`];
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return ['Agent output must be a JSON object.'];
  }
  const missing = requiredKeys.filter((key) => !(key in output));
  if (missing.length > 0) {
    return [`Agent output is missing required field(s): ${missing.join(', ')}.`];
  }
  return [];
}

/**
 * Second layer of validation, specific to the wave-2 business agents:
 * validateAgentOutputShape() above only confirms the top-level `tasks`
 * key exists — this checks that `tasks` is actually an array and that
 * each item has the minimum fields businessAgentRunner.js needs to
 * create a valid agent_tasks row (taskType, title). Returns an array of
 * problem strings; empty = valid.
 */
export function validateBusinessTaskItems(tasks) {
  if (!Array.isArray(tasks)) {
    return ['tasks must be an array.'];
  }
  if (tasks.length === 0) {
    return ['tasks must contain at least one suggested task.'];
  }
  const problems = [];
  tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      problems.push(`tasks[${index}] must be an object.`);
      return;
    }
    if (typeof task.taskType !== 'string' || !task.taskType.trim()) {
      problems.push(`tasks[${index}].taskType is required.`);
    }
    if (typeof task.title !== 'string' || !task.title.trim()) {
      problems.push(`tasks[${index}].title is required.`);
    }
  });
  return problems;
}

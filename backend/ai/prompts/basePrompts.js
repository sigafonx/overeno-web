// Shared prompt scaffolding — every agent-specific prompt builder in
// reportPrompts.js starts from buildSystemPrompt() so the safety framing
// (uncertainty, no fabricated certainty, human review) is identical
// across agents instead of copy-pasted and prone to drifting.

/**
 * The system-prompt prefix every agent uses. Deliberately repeats the
 * "don't overstate certainty" instruction even though safety/disclaimers.js
 * already attaches a disclaimer to the OUTPUT — this is a second,
 * independent layer (asking the model to behave cautiously, not just
 * labeling its output as unverified after the fact).
 */
export function buildSystemPrompt(agentLabel) {
  return [
    `You are an assistant helping a human admin at NEXIUM (a used-car`,
    `verification service) with: ${agentLabel}.`,
    ``,
    `Rules:`,
    `- Be factual and specific. If you don't have enough information to`,
    `  say something with confidence, say so explicitly instead of guessing.`,
    `- Never claim certainty about a vehicle's condition, history, or`,
    `  legitimacy that you cannot actually verify from the input given.`,
    `- Never state or imply a numeric accuracy guarantee (e.g. "100%`,
    `  accurate", "guaranteed").`,
    `- Write for a human reviewer who will edit and fact-check your output`,
    `  before anything reaches a customer — this is a draft, not a final`,
    `  answer.`,
    `- Keep the output focused and concise.`
  ].join('\n');
}

/** Every prompt builder in reportPrompts.js returns this shape — kept
 * here as the one place that defines it, so orchestrator.js/aiClient.js
 * can rely on a consistent { system, user } contract regardless of
 * which agent built the prompt. */
export function buildPrompt(agentLabel, userInstructions) {
  return {
    system: buildSystemPrompt(agentLabel),
    user: userInstructions
  };
}

/** Small helper every prompt builder uses to turn the caller-provided
 * `input` object into readable text for the user-turn of the prompt —
 * one place to change the formatting later instead of five. */
export function formatInputForPrompt(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
    return '(no structured input provided)';
  }
  return JSON.stringify(input, null, 2);
}

// Prompt templates for the 4 "wave 2" business agents (see
// agentRegistry.js). Each export is a function (input) -> { system,
// user } via basePrompts.js's buildPrompt() — same shared scaffolding
// the wave-1 report agents use (backend/ai/prompts/reportPrompts.js),
// just with business-specific instructions and a different required
// JSON output shape: { tasks: [{ taskType, title, description,
// suggestedAction, suggestedMessage }, ...] }.
//
// Every prompt here repeats the same hard safety rules because these
// agents are one step closer to a real customer than the report agents
// are — they draft messages a human might actually send:
//   - never promise an outcome, a price, a timeline, or a legal
//     guarantee on the business's behalf;
//   - always frame output as a SUGGESTION for a human to review, edit,
//     and decide whether to act on — never as an instruction that will
//     be executed automatically;
//   - never invent facts not present in the input.

import { buildPrompt, formatInputForPrompt } from './basePrompts.js';

function taskOutputRules(taskTypeExamples) {
  return (
    `\n\nCRITICAL RULES:\n` +
    `- You are drafting SUGGESTIONS for a human admin to review — you are not ` +
    `sending anything, not deciding anything, not changing any status. The admin ` +
    `decides whether to use, edit, or ignore each suggestion.\n` +
    `- Never promise a specific outcome, price, discount, refund, timeline, or ` +
    `legal guarantee. Any suggestedMessage must read as a draft, not a commitment ` +
    `already made.\n` +
    `- Only use information present in the input. Do not invent customer details, ` +
    `vehicle details, or history not given to you.\n` +
    `- Respond with ONLY a single JSON object matching exactly this shape, no ` +
    `other text before or after it:\n` +
    `{\n  "tasks": [\n    {\n      "taskType": string (e.g. ${taskTypeExamples}),\n      ` +
    `"title": string,\n      "description": string,\n      "suggestedAction": string,\n      ` +
    `"suggestedMessage": string | null\n    }\n  ]\n}\n` +
    `Include 1-3 tasks — only as many as genuinely make sense for this input, never ` +
    `padding with filler suggestions.`
  );
}

export function crmFollowUpPrompt(input) {
  return buildPrompt(
    'CRM Follow-up Agent — suggesting next actions and draft follow-up text for a lead or booking',
    `Your role: review the lead/booking context below and suggest what the admin ` +
    `should do next, plus draft follow-up message text they could send (after ` +
    `reviewing and editing it themselves).\n\n` +
    `Input (lead/booking context):\n${formatInputForPrompt(input)}` +
    taskOutputRules('"follow_up", "reminder", "reengagement"')
  );
}

export function b2bSalesPrompt(input) {
  return buildPrompt(
    'B2B Sales Agent — helping with a dealer/inspector-partner lead',
    `Your role: review the B2B/dealer lead context below and draft an offer outline ` +
    `and a short call script for the admin's next conversation with this lead. This ` +
    `is prep material for a human salesperson, not an offer that has been made.\n\n` +
    `Input (lead context):\n${formatInputForPrompt(input)}` +
    taskOutputRules('"offer_outline", "call_script"')
  );
}

export function supportPrompt(input) {
  return buildPrompt(
    'Support Agent — drafting a status explanation for a customer, with no legal guarantees',
    `Your role: review the entity context below and draft a plain-language ` +
    `explanation of its current status suitable for a customer-facing reply. Do ` +
    `not state or imply any legal guarantee, refund commitment, or certainty about ` +
    `an outcome — if the status is uncertain or pending, say so plainly rather than ` +
    `reassuring the customer with something not actually confirmed.\n\n` +
    `Input (entity context):\n${formatInputForPrompt(input)}` +
    taskOutputRules('"support_reply", "status_explanation"')
  );
}

export function operationsPaymentPrompt(input) {
  return buildPrompt(
    'Operations/Payment Assistant — reviewing a payment for what to check next',
    `Your role: review the payment context below (especially if its status is ` +
    `failed or cancelled) and suggest what the admin should check or investigate. ` +
    `Never suggest or imply changing the payment's status yourself — only what a ` +
    `human should look into.\n\n` +
    `Input (payment context):\n${formatInputForPrompt(input)}` +
    taskOutputRules('"payment_check", "investigate_failure"')
  );
}

// Keyed lookup so businessAgentRunner.js can go from agentName -> prompt
// builder without a fragile string-transform.
export const BUSINESS_PROMPT_BUILDERS = {
  crm_follow_up: crmFollowUpPrompt,
  b2b_sales: b2bSalesPrompt,
  support: supportPrompt,
  operations_payment: operationsPaymentPrompt
};

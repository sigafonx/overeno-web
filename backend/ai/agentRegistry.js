// Registry of AI agents — deliberately just a CATALOG (name, label,
// description, which entityTypes it can run against, and a `kind` that
// says which flow it belongs to):
//   kind: 'report'   -> the 5 "wave 1" agents (see reportPrompts.js),
//                       run via POST /admin/ai/run, persisted to
//                       ai_agent_runs, reviewable + applyable to a
//                       report's own content (see applyToReport.js).
//   kind: 'business' -> the 4 "wave 2" agents (see businessPrompts.js),
//                       run via POST /admin/agents/run-business-agent,
//                       persisted as one or more agent_tasks rows —
//                       suggestions for a human admin, never anything
//                       that touches a lead/booking/payment/report
//                       directly (see businessAgentRunner.js).
//
// None of these agents are "smart" yet — every one currently runs only
// through the mock provider (see aiClient.js).

export const AGENT_DEFINITIONS = {
  listing_analysis: {
    name: 'listing_analysis',
    label: 'Listing Analysis',
    description: 'Summarizes and flags potential red flags in a vehicle listing\'s text (price, description, photos count, etc. — text only, no image analysis).',
    entityTypes: ['report'],
    suggestedSectionKey: 'listing_risks',
    kind: 'report'
  },
  risk_scoring: {
    name: 'risk_scoring',
    label: 'Risk Scoring',
    description: 'Drafts a risk-level suggestion (low/medium/high) with reasoning — a suggestion for the admin to confirm, never an automatic score.',
    entityTypes: ['report'],
    suggestedSectionKey: null,
    kind: 'report'
  },
  report_writer: {
    name: 'report_writer',
    label: 'Report Writer',
    description: 'Drafts prose for a report section from structured input the admin provides — a starting point to edit, not a finished section.',
    entityTypes: ['report'],
    suggestedSectionKey: 'overview',
    kind: 'report'
  },
  buyer_advisor: {
    name: 'buyer_advisor',
    label: 'Buyer Advisor',
    description: 'Drafts buyer-facing questions to ask the seller and negotiation points — a starting point for the "seller_questions"/"price_negotiation" sections.',
    entityTypes: ['report'],
    suggestedSectionKey: 'seller_questions',
    kind: 'report'
  },
  vin_risk_explanation: {
    name: 'vin_risk_explanation',
    label: 'VIN Risk Explanation',
    description: 'Drafts a plain-language explanation of a VIN check\'s risk signals — a starting point for the "vin_result"/"odometer_risk"/"accident_risk" sections.',
    entityTypes: ['report', 'vin_check'],
    suggestedSectionKey: 'vin_result',
    kind: 'report'
  },

  // --- wave 2: business agents — produce agent_tasks, never touch any
  // entity directly, never send anything, never change a status. ---
  crm_follow_up: {
    name: 'crm_follow_up',
    label: 'CRM Follow-up Agent',
    description: 'Reviews a lead or booking and suggests a next action plus draft follow-up message text — the admin decides whether/how to actually send it.',
    entityTypes: ['lead', 'booking'],
    kind: 'business'
  },
  b2b_sales: {
    name: 'b2b_sales',
    label: 'B2B Sales Agent',
    description: 'Reviews a dealer/inspector-partner lead and drafts an offer outline and a call script — a starting point for a human sales conversation, not an offer that has actually been made.',
    entityTypes: ['lead'],
    kind: 'business'
  },
  support: {
    name: 'support',
    label: 'Support Agent',
    description: 'Drafts a plain-language explanation of an entity\'s current status for a customer-facing reply — never states a legal guarantee or a promised outcome.',
    entityTypes: ['lead', 'booking', 'vin_check', 'payment'],
    kind: 'business'
  },
  operations_payment: {
    name: 'operations_payment',
    label: 'Operations/Payment Assistant',
    description: 'Reviews a failed/cancelled/paid payment and suggests what an admin should check next — never changes the payment\'s status itself.',
    entityTypes: ['payment'],
    kind: 'business'
  }
};

export const ALLOWED_AGENT_NAMES = Object.keys(AGENT_DEFINITIONS);
export const REPORT_AGENT_NAMES = Object.values(AGENT_DEFINITIONS).filter((a) => a.kind === 'report').map((a) => a.name);
export const BUSINESS_AGENT_NAMES = Object.values(AGENT_DEFINITIONS).filter((a) => a.kind === 'business').map((a) => a.name);

// Union of every entityType any registered agent accepts — used by
// validation in server.js so "is this entityType allowed at all" stays
// in sync with the registry automatically as agents are added later.
export const ALLOWED_ENTITY_TYPES = [...new Set(Object.values(AGENT_DEFINITIONS).flatMap((a) => a.entityTypes))];

export function getAgentDefinition(agentName) {
  return AGENT_DEFINITIONS[agentName] || null;
}

export function isAgentAllowedForEntityType(agentName, entityType) {
  const def = getAgentDefinition(agentName);
  return !!def && def.entityTypes.includes(entityType);
}

export function listAgentDefinitions() {
  return Object.values(AGENT_DEFINITIONS);
}

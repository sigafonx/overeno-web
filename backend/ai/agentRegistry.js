// Registry of AI agents — deliberately just a CATALOG (name, label,
// description, which entityTypes it can run against, and a `kind` that
// says which flow it belongs to):
//   kind: 'report'   -> the 5 "wave 1" agents (see reportPrompts.js),
//                       run via POST /admin/ai/run, persisted to
//                       ai_agent_runs, reviewable + applyable to a
//                       report's own content (see applyToReport.js).
//   kind: 'business' -> the 9 "wave 2/3" agents (see businessPrompts.js),
//                       run via POST /admin/agents/run-business-agent,
//                       persisted as one or more agent_tasks rows —
//                       suggestions for a human admin, never anything
//                       that touches a lead/booking/payment/report
//                       directly (see businessAgentRunner.js).
//
// Every agent also carries the governance metadata the admin UI shows on
// its catalog page (GET /admin/ai/agents): allowedActions/forbiddenActions
// (plain-language boundaries, not enforced by code beyond what
// businessAgentRunner.js/orchestrator.js/applyToReport.js already do —
// this is documentation for a human reviewer, not a new permission
// system), inputTypes, outputFormat, riskLevel, a short systemPrompt
// summary (the full dynamic prompt lives in prompts/reportPrompts.js /
// prompts/businessPrompts.js — this is a human-readable summary of it),
// and status (active/inactive — all active by default; there is no
// per-agent DB-backed toggle in this step, disabling one means setting
// AI_ENABLED=false globally or simply not calling it).
//
// Every agent currently runs through whichever provider AI_PROVIDER
// selects (see aiClient.js) — "mock" (deterministic, offline, free) or
// "openai" (real GPT call, gated by OPENAI_API_KEY + AI_MONTHLY_BUDGET_LIMIT).

const COMMON_FORBIDDEN_ACTIONS = [
  'Never sends an email, SMS, or any message to a customer automatically.',
  'Never changes a lead/booking/payment/vin_check/report status itself.',
  'Never moves, charges, refunds, or transfers money.',
  'Never invents facts, history, or data not present in its input.',
  'Never states a numeric accuracy guarantee (e.g. "100% accurate").'
];

export const AGENT_DEFINITIONS = {
  // --- wave 1: report-writing agents (kind: 'report') ---------------------
  listing_analysis: {
    name: 'listing_analysis',
    label: 'Listing Analysis',
    description: 'Summarizes and flags potential red flags in a vehicle listing\'s text (price, description, photos count, etc. — text only, no image analysis).',
    entityTypes: ['report'],
    suggestedSectionKey: 'listing_risks',
    kind: 'report',
    riskLevel: 'low',
    inputTypes: ['report_context', 'vin_check_summary', 'booking_summary'],
    outputFormat: 'JSON: { redFlags[], missingInfo[], sellerQuestions[], confidence, summary }',
    allowedActions: [
      'Reads report/vin_check/booking context already gathered for a report.',
      'Flags text-based inconsistencies, vague wording, or missing details.',
      'Drafts seller questions for the admin to ask.'
    ],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never analyzes photos or images (text/structured data only).'],
    systemPrompt: 'Reviews report context for red flags in a listing\'s text and drafts seller questions — output is a draft for a human admin to fact-check before it reaches a report.',
    status: 'active'
  },
  risk_scoring: {
    name: 'risk_scoring',
    label: 'Risk Scoring',
    description: 'Drafts a risk-level suggestion (low/medium/high) with reasoning — a suggestion for the admin to confirm, never an automatic score.',
    entityTypes: ['report'],
    suggestedSectionKey: null,
    kind: 'report',
    riskLevel: 'medium',
    inputTypes: ['report_context', 'vin_check_summary'],
    outputFormat: 'JSON: { score(0-100), riskLevel, riskFactors[], protectiveFactors[], explanation }',
    allowedActions: [
      'Suggests a 0-100 score and low/medium/high risk level from available context.',
      'Lists specific risk factors and protective factors it found in the input.'
    ],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never writes its suggestion directly into reports.score/riskLevel — an admin must apply it explicitly.'],
    systemPrompt: 'Suggests a risk score/level with reasoning for a report, always as a suggestion a human admin must confirm or override.',
    status: 'active'
  },
  report_writer: {
    name: 'report_writer',
    label: 'Report Writer',
    description: 'Drafts prose for a report section from structured input the admin provides — a starting point to edit, not a finished section.',
    entityTypes: ['report'],
    suggestedSectionKey: 'overview',
    kind: 'report',
    riskLevel: 'medium',
    inputTypes: ['report_context', 'report_sections'],
    outputFormat: 'JSON: { sections[{sectionKey, title, content}], summary, verdict }',
    allowedActions: [
      'Drafts prose for report sections that already exist on the report.',
      'Suggests a summary and verdict line.'
    ],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never invents a sectionKey that isn\'t already part of the report.', 'Draft content never reaches the report or a customer until an admin explicitly applies it.'],
    systemPrompt: 'Drafts report section prose and a summary/verdict from structured context — always a first draft requiring human edit before use.',
    status: 'active'
  },
  buyer_advisor: {
    name: 'buyer_advisor',
    label: 'Buyer Advisor',
    description: 'Drafts buyer-facing questions to ask the seller and negotiation points — a starting point for the "seller_questions"/"price_negotiation" sections.',
    entityTypes: ['report'],
    suggestedSectionKey: 'seller_questions',
    kind: 'report',
    riskLevel: 'medium',
    inputTypes: ['report_context', 'vin_check_summary'],
    outputFormat: 'JSON: { recommendation, nextSteps[], negotiationPoints[], questionsForSeller[] }',
    allowedActions: [
      'Drafts a recommendation (consider/inspect_first/avoid) with reasoning.',
      'Drafts negotiation points and seller questions specific to the listing.'
    ],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never presents its recommendation as a guarantee of the vehicle\'s condition.'],
    systemPrompt: 'Drafts buyer guidance (recommendation, next steps, negotiation points, seller questions) for human review before it reaches a customer.',
    status: 'active'
  },
  vin_risk_explanation: {
    name: 'vin_risk_explanation',
    label: 'VIN Report Agent',
    description: 'Explains a VIN check\'s risk signals in plain language for a non-expert buyer — uses only the VIN check\'s own result, never invents history the VIN result doesn\'t contain.',
    entityTypes: ['report', 'vin_check'],
    suggestedSectionKey: 'vin_result',
    kind: 'report',
    riskLevel: 'medium',
    inputTypes: ['vin_check_result'],
    outputFormat: 'JSON: { vinSummary, riskExplanation, limitations[] }',
    allowedActions: [
      'Reads one VIN check\'s normalized result (score, riskLevel, odometer risk, accidents, owners, isDemoResult).',
      'Explains those signals in plain language for a customer-facing draft.',
      'Explicitly flags when the underlying VIN data is demo/unverified.'
    ],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never describes demo/mock VIN data as an official or verified vehicle history report.', 'Never adds accident/mileage/owner facts beyond what the VIN check result already contains.'],
    systemPrompt: 'Plain-language explanation of a VIN check\'s own risk signals (score, odometer risk, accidents, owners) — never adds facts the VIN result doesn\'t contain, and always flags demo/unverified data as such.',
    status: 'active'
  },

  // --- wave 2/3: business agents (kind: 'business') — produce agent_tasks,
  // never touch any entity directly, never send anything, never change a
  // status. See businessAgentRunner.js for the enforcement. -------------
  crm_follow_up: {
    name: 'crm_follow_up',
    label: 'CRM Follow-up Agent',
    description: 'Reviews a lead or booking and suggests a next action plus draft follow-up message text — the admin decides whether/how to actually send it.',
    entityTypes: ['lead', 'booking'],
    kind: 'business',
    riskLevel: 'medium',
    inputTypes: ['lead_data', 'booking_data'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: ['Suggests a next action for a lead/booking.', 'Drafts follow-up message text as a DRAFT for the admin to review, edit, and decide whether to send.'],
    forbiddenActions: COMMON_FORBIDDEN_ACTIONS,
    systemPrompt: 'Suggests next actions and drafts follow-up text for a lead/booking — always a suggestion, the admin decides whether to use it.',
    status: 'active'
  },
  b2b_sales: {
    name: 'b2b_sales',
    label: 'B2B Sales Agent',
    description: 'Reviews a dealer/inspector-partner lead and drafts an offer outline and a call script — a starting point for a human sales conversation, not an offer that has actually been made.',
    entityTypes: ['lead'],
    kind: 'business',
    riskLevel: 'medium',
    inputTypes: ['lead_data'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: ['Drafts an offer outline and call-script talking points for a B2B/dealer lead.'],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never presents a draft offer outline as an offer that has actually been made to the partner.'],
    systemPrompt: 'Drafts an offer outline and call script for a dealer/inspector-partner lead — prep material for a human salesperson, not a real offer.',
    status: 'active'
  },
  support: {
    name: 'support',
    label: 'Email Support Agent',
    description: 'Reviews a lead/booking/vin_check/payment/email_log and drafts a plain-language status explanation or follow-up email text — never sends anything itself, the admin always sends manually.',
    entityTypes: ['lead', 'booking', 'vin_check', 'payment', 'email_log'],
    kind: 'business',
    riskLevel: 'medium',
    inputTypes: ['lead_data', 'booking_data', 'vin_check_summary', 'payment_data', 'email_log_data'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: [
      'Drafts a plain-language status explanation for a customer-facing reply.',
      'For a failed/skipped email_log entry, drafts a follow-up email an admin could send manually.'
    ],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never sends, resends, or retries an email itself — only the backend\'s own email service does that, and only for its own automated notifications.', 'Never states a legal guarantee or promised refund/outcome.'],
    systemPrompt: 'Drafts a plain-language, no-guarantee status explanation or follow-up email text for a customer — never sends anything itself.',
    status: 'active'
  },
  operations_payment: {
    name: 'operations_payment',
    label: 'Payment Control Agent',
    description: 'Reviews a payment (paid/cancelled/failed) and explains which booking/vin_check it\'s linked to and what an admin should check next — never changes the payment\'s status or moves money.',
    entityTypes: ['payment'],
    kind: 'business',
    riskLevel: 'medium',
    inputTypes: ['payment_data'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: ['Explains a payment\'s current status and its linked entity.', 'Suggests what to check next for a failed/cancelled payment.'],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never changes a payment\'s status.', 'Never initiates, retries, or reverses a charge/refund.'],
    systemPrompt: 'Reviews a payment\'s status and its linked booking/vin_check, and suggests what an admin should check next — never changes the payment itself.',
    status: 'active'
  },
  lead_qualification: {
    name: 'lead_qualification',
    label: 'Lead Qualification Agent',
    description: 'Analyzes a new lead: flags urgency, checks whether required information is present, and suggests the next qualification step.',
    entityTypes: ['lead'],
    kind: 'business',
    riskLevel: 'low',
    inputTypes: ['lead_data'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: ['Flags missing required fields (contact name, city, message, company name for dealer leads).', 'Estimates urgency from how long ago the lead was created.', 'Suggests the next qualification step.'],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never marks a lead qualified/not_qualified itself — that stays an admin decision on admin-leads.html.'],
    systemPrompt: 'Checks a lead for completeness and urgency and suggests the next qualification step — never changes the lead\'s own status.',
    status: 'active'
  },
  booking_coordinator_agent: {
    name: 'booking_coordinator_agent',
    label: 'Booking Coordinator Agent',
    description: 'Analyzes an inspection booking and drafts a checklist to help the admin decide what needs to be assigned/confirmed before an inspector visit.',
    entityTypes: ['booking'],
    kind: 'business',
    riskLevel: 'low',
    inputTypes: ['booking_data'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: ['Drafts a pre-inspection checklist (slot/city/VIN/listing confirmation) from the booking\'s own data.', 'Suggests when an inspector should be assigned.'],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never assigns an inspector or creates/edits an inspection_jobs row itself — that stays an explicit admin action on admin-inspection-jobs.html.'],
    systemPrompt: 'Drafts a pre-inspection checklist for a booking and suggests inspector-assignment timing — never assigns anyone itself.',
    status: 'active'
  },
  admin_operations: {
    name: 'admin_operations',
    label: 'Admin Operations Agent',
    description: 'Produces a daily cross-entity operational summary (leads/bookings/vin_checks/payments/email_logs counts) flagging what needs attention — aggregate counts only, no per-record PII.',
    entityTypes: ['dashboard'],
    kind: 'business',
    riskLevel: 'low',
    inputTypes: ['dashboard_aggregate_counts'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: ['Reads aggregate counts (new leads, bookings needing action, failed payments, failed emails, pending VIN checks) over a recent window.', 'Flags which categories need attention and suggests where to look.'],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never receives or reasons over individual customer PII (email/phone/name) — only counts.', 'Never changes any record it summarizes.'],
    systemPrompt: 'Daily cross-entity operations summary from aggregate counts only — flags what needs attention, changes nothing.',
    status: 'active'
  },
  revenue_share_agent: {
    name: 'revenue_share_agent',
    label: 'Revenue Share Agent',
    description: 'Explains the current revenue-share calculation (gross paid revenue, share percent, share amount, payout status) transparently — a read-only summary of the existing ledger/payout records, never a transfer.',
    entityTypes: ['revenue_share'],
    kind: 'business',
    riskLevel: 'medium',
    inputTypes: ['revenue_share_summary'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: ['Reads the existing revenue-share settings/ledger/payout-preview for one month (see backend/revenueShare/revenueShareService.js).', 'Explains gross revenue, share percent/amount, and payout due date/status in plain language.'],
    forbiddenActions: [
      ...COMMON_FORBIDDEN_ACTIONS,
      'Never calculates, creates, or edits a payout row itself — read-only.',
      'Never initiates or performs any transfer (Wise or otherwise).',
      'Never sees or handles card/account numbers — those are never stored in this system in the first place.'
    ],
    systemPrompt: 'Transparent, read-only explanation of the revenue-share ledger/payout numbers for one month — no calculation is changed and no money ever moves through this agent.',
    status: 'active'
  },
  business_growth: {
    name: 'business_growth',
    label: 'Business Growth Agent',
    description: 'Suggests conversion/growth ideas from aggregate operational and revenue data — always framed as scenarios with stated assumptions, never a guaranteed forecast.',
    entityTypes: ['dashboard'],
    kind: 'business',
    riskLevel: 'medium',
    inputTypes: ['dashboard_aggregate_counts', 'revenue_share_summary'],
    outputFormat: 'JSON: { tasks: [{ taskType, title, description, suggestedAction, suggestedMessage }] }',
    allowedActions: ['Suggests conversion/pricing/follow-up experiments to consider, based only on the aggregate data given.', 'States assumptions explicitly when describing a possible scenario.'],
    forbiddenActions: [...COMMON_FORBIDDEN_ACTIONS, 'Never promises or guarantees a specific revenue/profit outcome.', 'Never presents a scenario as a forecast that will definitely happen.'],
    systemPrompt: 'Suggests growth/conversion ideas as scenarios with explicit assumptions — never a guaranteed forecast or promised profit.',
    status: 'active'
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

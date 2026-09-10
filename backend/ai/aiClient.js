import crypto from 'crypto';
import OpenAI from 'openai';
import { AI_PROVIDER_NAME, AI_MODEL, AI_MONTHLY_BUDGET_LIMIT, AI_TEMPERATURE, AI_MAX_OUTPUT_TOKENS, OPENAI_MODEL } from './aiConfig.js';

// ---------------------------------------------------------------------------
// Provider interface every provider below must implement:
//   getProviderName(): string
//   isConfigured(): boolean
//   runAgent({ agentName, prompt: { system, user }, input })
//     -> Promise<{ output: object, estimatedCost: string, model: string }>
//
// `output` must be a plain JSON object matching the shape registered in
// backend/ai/safety/aiGuards.js's AGENT_OUTPUT_SCHEMAS for `agentName` —
// orchestrator.js validates this right after the call and treats a
// mismatch as a failed run (see orchestrator.js's runAgent()).
//
// orchestrator.js only ever calls getAiProvider() + .runAgent() — it
// never imports a specific provider directly, so adding a real provider
// later means adding one branch below, nothing else in backend/ai/
// changes shape.
// ---------------------------------------------------------------------------

function promptHash(prompt) {
  return crypto.createHash('sha256').update(`${prompt.system}\n---\n${prompt.user}`).digest('hex');
}

/** Deterministic pseudo-random pick from a hash string — same hash
 * always picks the same index, different hash usually picks a
 * different one. Used to give mock output a bit of realistic variety
 * across different inputs without breaking determinism for the SAME
 * input (see aiClient.js's own tests: identical input -> identical
 * output, always). */
function pickFromHash(hash, offset, options) {
  const slice = hash.slice(offset, offset + 8);
  const n = parseInt(slice, 16) || 0;
  return options[n % options.length];
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// Structured, deterministic, realistic-looking mock generators — one per
// agent. Each reads whatever it can from `input` (the report context
// built by backend/ai/reportContext.js when the admin just clicks "Run"
// against a report — see orchestrator.js) and falls back to sensible
// generic content when a field isn't present, so these never return an
// empty/useless result even with a bare {} input.
// ---------------------------------------------------------------------------

function mockListingAnalysis(input, hash) {
  const vinCheck = input.vinCheck || null;
  const booking = input.booking || null;
  const redFlags = [];
  const missingInfo = [];

  if (vinCheck && vinCheck.odometerRisk && vinCheck.odometerRisk !== 'low') {
    redFlags.push(`VIN check flags odometer risk as "${vinCheck.odometerRisk}" — advertised mileage should be double-checked against the input's own estimate.`);
  }
  if (vinCheck && Number(vinCheck.accidents) > 0) {
    redFlags.push(`Input reports ${vinCheck.accidents} recorded accident(s) — worth asking the seller for repair documentation.`);
  }
  if (!booking || !booking.listingUrl) {
    missingInfo.push('No listing URL provided in the input — cannot cross-check the original ad text.');
  }
  if (!vinCheck && !booking) {
    missingInfo.push('No linked VIN check or booking data was available in the input for this report.');
  }
  if (redFlags.length === 0) {
    redFlags.push('No specific red flags identified from the information provided — this does not confirm the listing is problem-free, only that nothing stood out in this limited input.');
  }

  const sellerQuestions = [
    'Can you share the full accident/repair history, including any insurance claims?',
    'Why is the vehicle being sold, and how long has it been listed?'
  ];

  const confidence = (vinCheck || booking) ? pickFromHash(hash, 0, ['medium', 'medium', 'high']) : 'low';

  return {
    redFlags,
    missingInfo,
    sellerQuestions,
    confidence,
    summary: `Based on the available input, ${redFlags.length} potential concern(s) and ${missingInfo.length} information gap(s) were identified. This is a mock/offline analysis — see redFlags and missingInfo for specifics.`
  };
}

function mockRiskScoring(input, hash) {
  const vinCheck = input.vinCheck || null;
  const reportRiskLevel = (input.report && input.report.riskLevel) || (vinCheck && vinCheck.riskLevel) || null;

  const riskLevel = reportRiskLevel || pickFromHash(hash, 8, ['low', 'medium', 'high']);
  const score = riskLevel === 'low' ? 20 + (parseInt(hash.slice(16, 18), 16) % 15)
    : riskLevel === 'high' ? 70 + (parseInt(hash.slice(16, 18), 16) % 25)
    : 40 + (parseInt(hash.slice(16, 18), 16) % 25);

  const riskFactors = [];
  const protectiveFactors = [];

  if (vinCheck && vinCheck.odometerRisk && vinCheck.odometerRisk !== 'low') {
    riskFactors.push(`Odometer risk flagged as "${vinCheck.odometerRisk}" in the input.`);
  }
  if (vinCheck && Number(vinCheck.accidents) > 0) {
    riskFactors.push(`${vinCheck.accidents} accident(s) reported in the input data.`);
  }
  if (vinCheck && Number(vinCheck.owners) <= 1) {
    protectiveFactors.push('Input indicates a single-owner history, which is generally a positive signal.');
  }
  if (riskFactors.length === 0) riskFactors.push('No specific risk factors were present in the available input.');
  if (protectiveFactors.length === 0) protectiveFactors.push('No specific protective factors were present in the available input.');

  return {
    score,
    riskLevel,
    riskFactors,
    protectiveFactors,
    explanation: `Suggested risk level "${riskLevel}" (score ${score}/100) is based only on the input data provided — this is a suggestion for the admin to confirm or override, not a final assessment.${vinCheck && vinCheck.isDemoResult ? ' Note: the underlying VIN check is demo data, not an official vehicle history report.' : ''}`
  };
}

function mockReportWriter(input, hash) {
  const existingSections = Array.isArray(input.sections) ? input.sections : [];
  const emptySections = existingSections.filter((s) => !str(s.content)).slice(0, 2);

  const sections = emptySections.map((s) => ({
    sectionKey: s.sectionKey,
    title: s.title || s.sectionKey,
    content: `[Mock draft for "${s.sectionKey}"] Based on the available report context, this section would summarize the relevant findings here. This is placeholder text from the offline mock provider — an admin must review and rewrite this before it's used in any real report.`
  }));

  if (sections.length === 0 && existingSections.length > 0) {
    // Every section already has content — still return something
    // meaningful rather than an empty array, using the first section
    // as a "suggested revision" example.
    const first = existingSections[0];
    sections.push({
      sectionKey: first.sectionKey,
      title: first.title || first.sectionKey,
      content: `[Mock suggested revision for "${first.sectionKey}"] ${first.content} (mock provider offers no real improvement here — offline placeholder only.)`
    });
  }

  return {
    sections,
    summary: 'Mock report writer summary: this draft was generated by the offline mock provider from the report context provided, and has not been fact-checked.',
    verdict: pickFromHash(hash, 24, [
      'Draft verdict (mock): further review recommended before drawing conclusions.',
      'Draft verdict (mock): available information is limited; treat with caution.',
      'Draft verdict (mock): no major concerns identified in this limited input.'
    ])
  };
}

function mockBuyerAdvisor(input, hash) {
  const riskLevel = (input.report && input.report.riskLevel) || (input.vinCheck && input.vinCheck.riskLevel) || null;
  const recommendation = riskLevel === 'high' ? 'avoid' : riskLevel === 'low' ? 'consider' : pickFromHash(hash, 32, ['inspect_first', 'inspect_first', 'consider']);

  return {
    recommendation,
    nextSteps: [
      'Arrange an independent physical inspection before finalizing the purchase.',
      'Request full documentation (service history, accident records) directly from the seller.'
    ],
    negotiationPoints: [
      'Use any flagged risk factors from the report as a basis to discuss price.',
      'Ask whether the price accounts for any known needed repairs.'
    ],
    questionsForSeller: [
      'Is the vehicle currently under any manufacturer or extended warranty?',
      'Are there any outstanding loans or liens on the vehicle?'
    ]
  };
}

function mockVinRiskExplanation(input, hash) {
  const vinCheck = input.vinCheck || null;

  if (!vinCheck) {
    return {
      vinSummary: 'No VIN check data was available in the input for this report.',
      riskExplanation: 'Without VIN check data, no risk explanation can be generated — this is a limitation of the input, not a finding.',
      limitations: ['No linked VIN check data was provided.']
    };
  }

  const demoNote = vinCheck.isDemoResult
    ? 'This is demo/sample data, not an official vehicle history report — treat it as illustrative only.'
    : '';

  return {
    vinSummary: `VIN ${vinCheck.vin || '(unknown)'}${vinCheck.year ? `, ${vinCheck.year}` : ''}: input reports ${vinCheck.accidents ?? 'an unknown number of'} accident(s) and ${vinCheck.owners ?? 'an unknown number of'} owner(s). ${demoNote}`.trim(),
    riskExplanation: `Risk level in the input is "${vinCheck.riskLevel || 'not specified'}"${vinCheck.odometerRisk ? `, with odometer risk flagged as "${vinCheck.odometerRisk}"` : ''}. This explanation only restates and contextualizes what the input already contains — it does not add new findings.`,
    limitations: [
      demoNote || 'This explanation is based only on the VIN check data provided as input.',
      'A VIN check does not replace a physical inspection by a qualified mechanic.'
    ].filter(Boolean)
  };
}

// ---------------------------------------------------------------------------
// Wave 2 — business agent mock generators. Same determinism contract as
// the wave-1 generators above (same input -> same output), and every
// generated `suggestedMessage` is deliberately written as a DRAFT (never
// a commitment) — see businessPrompts.js's shared safety rules, which
// these mirror even though this is mock output, not a real model
// following that prompt.
// ---------------------------------------------------------------------------

function mockCrmFollowUp(input, hash) {
  const lead = input.lead || null;
  const booking = input.booking || null;
  const entity = lead || booking || {};
  const name = entity.contactName || 'there';
  const city = entity.city || 'your area';

  const daysSinceCreated = entity.createdAt
    ? Math.max(0, Math.floor((Date.now() - new Date(entity.createdAt).getTime()) / 86400000))
    : null;

  const taskType = pickFromHash(hash, 0, ['follow_up', 'reminder', 'reengagement']);

  return {
    tasks: [
      {
        taskType,
        title: lead ? 'Follow up on this lead' : 'Follow up on this booking',
        description: `Mock CRM analysis: ${daysSinceCreated !== null ? `created ${daysSinceCreated} day(s) ago, ` : ''}status "${entity.status || 'unknown'}". A short check-in may help move this forward.`,
        suggestedAction: 'Review the details below and send a personalized follow-up if it still applies.',
        suggestedMessage: `Hi ${name}, following up on your ${lead ? 'inquiry' : 'booking request'} in ${city} — just checking whether you still have questions or would like to move ahead. [DRAFT — review before sending, mock provider output]`
      }
    ]
  };
}

function mockB2bSales(input, hash) {
  const lead = input.lead || {};
  const company = lead.companyName || 'the dealership';

  return {
    tasks: [
      {
        taskType: 'offer_outline',
        title: 'Draft B2B offer outline',
        description: `Mock B2B analysis for ${company}: outline based only on the input provided — no pricing has actually been offered yet.`,
        suggestedAction: 'Review and customize the offer outline before sharing it with the partner.',
        suggestedMessage: `[DRAFT OFFER OUTLINE — mock provider output] Volume-based partnership outline for ${company}: per-check pricing tiers to be confirmed by sales, onboarding call to follow. Not an offer that has been made yet.`
      },
      {
        taskType: 'call_script',
        title: 'Draft call script',
        description: 'Short talking points for the next call with this lead — based only on the information provided.',
        suggestedAction: 'Review before the call; adjust based on what you already know about this partner.',
        suggestedMessage: pickFromHash(hash, 0, [
          '[DRAFT CALL SCRIPT — mock] 1) Confirm their current volume/needs. 2) Walk through report turnaround. 3) Ask about their current verification process.',
          '[DRAFT CALL SCRIPT — mock] 1) Thank them for reaching out. 2) Ask what prompted the inquiry. 3) Propose a short onboarding call.'
        ])
      }
    ]
  };
}

function mockSupport(input, hash) {
  const entity = input.lead || input.booking || input.vinCheck || input.payment || {};
  const status = entity.status || 'unknown';

  return {
    tasks: [
      {
        taskType: 'support_reply',
        title: 'Draft status explanation for the customer',
        description: `Mock support draft explaining status "${status}" in plain language — no guarantee or promised outcome included.`,
        suggestedAction: 'Review and personalize before sending — confirm the status is still current.',
        suggestedMessage: `[DRAFT — mock provider output] Thanks for checking in. Your request is currently "${status}". We don't have a guaranteed timeline to share yet, but we'll follow up as soon as there's an update.`
      }
    ]
  };
}

function mockOperationsPayment(input, hash) {
  const payment = input.payment || {};
  const status = payment.status || 'unknown';

  const checks = [];
  if (status === 'failed') checks.push('Check the payment provider dashboard for the specific decline/error reason.');
  if (status === 'cancelled') checks.push('Confirm whether the customer intentionally cancelled or the session simply expired.');
  if (status === 'paid') checks.push('Confirm the linked entity (booking/vin_check) was correctly marked paid.');
  if (checks.length === 0) checks.push('Review the payment record for anything unusual given its current status.');

  return {
    tasks: [
      {
        taskType: 'payment_check',
        title: `Review ${status} payment`,
        description: `Mock operations analysis: payment status is "${status}". Suggested checks below — this does not change the payment's status.`,
        suggestedAction: checks.join(' '),
        suggestedMessage: null
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Wave 3 — 5 additional business agents rounding out the 8-role business
// catalog (Lead Qualification / VIN Report [=vin_risk_explanation] /
// Booking Coordinator / Payment Control [=operations_payment] / Email
// Support [=support, extended to entityType "email_log"] / Admin
// Operations / Revenue Share / Business Growth). Same determinism and
// safety contract as wave 2 above — draft suggestions only, never an
// automatic action, never a guaranteed outcome.
// ---------------------------------------------------------------------------

function mockLeadQualification(input, hash) {
  const lead = input.lead || {};
  const missing = [];
  if (!lead.contactName) missing.push('contact name');
  if (!lead.city) missing.push('city');
  if (!lead.message) missing.push('a message describing what they need');
  if (lead.type === 'dealer_request' && !lead.companyName) missing.push('company name');

  const daysOld = lead.createdAt ? Math.max(0, Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / 86400000)) : null;
  const urgency = daysOld === null ? 'unknown' : daysOld >= 3 ? 'high' : daysOld >= 1 ? 'medium' : 'low';

  const nextStep = missing.length > 0
    ? `Ask for the missing information (${missing.join(', ')}) before qualifying further.`
    : lead.qualification
      ? `Input already marks qualification as "${lead.qualification}" — confirm this is still accurate, then move to the next step for that qualification.`
      : 'Enough basic information is present — an admin should manually assess fit and decide the next step (contact, quote, decline).';

  return {
    tasks: [{
      taskType: 'lead_qualification_review',
      title: 'Review lead qualification and urgency',
      description: `Mock qualification analysis: urgency "${urgency}"${daysOld !== null ? ` (${daysOld} day(s) since created)` : ''}. ${missing.length > 0 ? `Missing: ${missing.join(', ')}.` : 'No obvious data gaps found in the input.'}`,
      suggestedAction: nextStep,
      suggestedMessage: missing.length > 0
        ? `Hi ${lead.contactName || 'there'}, thanks for reaching out — could you share ${missing.join(' and ')} so we can help you faster? [DRAFT — mock provider output]`
        : null
    }]
  };
}

function mockBookingCoordinator(input, hash) {
  const booking = input.booking || {};
  const checklist = [
    `Confirm preferred slot "${booking.preferredSlot || 'not specified'}" is still available.`,
    `Confirm inspection location covers city "${booking.city || 'not specified'}".`,
    booking.vin ? `VIN ${booking.vin} provided — cross-check against any linked VIN check before the visit.` : 'No VIN provided — ask for one before the inspection if possible.',
    booking.listingUrl ? 'Listing URL provided — inspector should review it before arriving.' : 'No listing URL provided — nothing to pre-review.'
  ];

  return {
    tasks: [{
      taskType: 'inspection_checklist',
      title: 'Prepare inspector assignment checklist',
      description: `Mock booking-coordinator analysis for status "${booking.status || 'unknown'}". Checklist:\n- ${checklist.join('\n- ')}`,
      suggestedAction: 'Assign an inspector via admin-inspection-jobs.html once the checklist above is confirmed — this suggestion does not assign anyone itself.',
      suggestedMessage: null
    }]
  };
}

function mockAdminOperations(input, hash) {
  const d = input.dashboard || {};
  const attention = [];
  if ((d.newLeadsCount || 0) > 0) attention.push(`${d.newLeadsCount} new lead(s)`);
  if ((d.bookingsNeedingActionCount || 0) > 0) attention.push(`${d.bookingsNeedingActionCount} booking(s) needing action`);
  if ((d.failedPaymentsCount || 0) > 0) attention.push(`${d.failedPaymentsCount} failed payment(s)`);
  if ((d.failedEmailsCount || 0) > 0) attention.push(`${d.failedEmailsCount} failed email(s)`);
  if (attention.length === 0) attention.push('nothing flagged in the counts provided');

  return {
    tasks: [{
      taskType: 'daily_summary',
      title: 'Daily operations summary',
      description: `Mock cross-entity summary (counts only, no PII): ${attention.join('; ')}. Window: ${d.windowDays || 7} day(s).`,
      suggestedAction: 'Review the flagged categories in their own admin pages (leads/bookings/payments/email logs) — this summary does not change any record.',
      suggestedMessage: null
    }]
  };
}

function mockRevenueShareAgent(input, hash) {
  const rs = input.revenueShare || {};
  const currency = rs.currency ? ` ${rs.currency}` : '';
  return {
    tasks: [{
      taskType: 'revenue_share_summary',
      title: `Revenue-share summary for ${rs.monthKey || 'this month'}`,
      description: `Mock transparent calculation: gross paid revenue ${rs.grossRevenue ?? 'n/a'}${currency}, share ${rs.sharePercent ?? 20}% = ${rs.shareAmount ?? 'n/a'}${currency}. Based on ${rs.ledgerEntryCount ?? 0} accrued ledger entr(y/ies). Payout due ${rs.payoutDueAt || 'not yet calculated'}, status "${rs.payoutStatus || 'not yet calculated'}".`,
      suggestedAction: 'This is a read-only summary of the existing revenue-share ledger/payout records — no transfer, deduction, or status change happens here. Use admin-revenue-share.html to calculate/mark payouts.',
      suggestedMessage: null
    }]
  };
}

function mockBusinessGrowth(input, hash) {
  const d = input.dashboard || {};
  const rs = input.revenueShare || {};
  const ideas = pickFromHash(hash, 0, [
    ['Review pricing/positioning for the product with the most cancelled/failed payments.', 'Consider a short follow-up sequence for leads older than 3 days with no contact yet.'],
    ['Check whether VIN checks with high risk scores convert to inspection bookings at a different rate than low-risk ones.', 'Look at which lead source (source field) produces the most qualified leads.'],
    ['Consider a lightweight reminder for bookings stuck in "waiting_payment" for more than a few days.', 'Review dealer/partner leads specifically — b2b_sales tasks may be going stale.']
  ]);

  return {
    tasks: [{
      taskType: 'growth_scenario',
      title: 'Growth/conversion suggestions (scenarios, not guarantees)',
      description: `Mock scenario-based suggestions from available aggregate data (revenue this month: ${rs.grossRevenue ?? 'n/a'} ${rs.currency || ''}). These are hypotheses to test, not guaranteed outcomes — no forecast here is a promise of future revenue.`,
      suggestedAction: ideas.join(' '),
      suggestedMessage: null
    }]
  };
}

const MOCK_GENERATORS = {
  listing_analysis: mockListingAnalysis,
  risk_scoring: mockRiskScoring,
  report_writer: mockReportWriter,
  buyer_advisor: mockBuyerAdvisor,
  vin_risk_explanation: mockVinRiskExplanation,
  crm_follow_up: mockCrmFollowUp,
  b2b_sales: mockB2bSales,
  support: mockSupport,
  operations_payment: mockOperationsPayment,
  lead_qualification: mockLeadQualification,
  booking_coordinator_agent: mockBookingCoordinator,
  admin_operations: mockAdminOperations,
  revenue_share_agent: mockRevenueShareAgent,
  business_growth: mockBusinessGrowth
};

/**
 * Deterministic mock provider — same agentName + same input always
 * produces the same output (verified by tests: re-run with identical
 * input, get byte-identical JSON back). No network call, no cost, works
 * with zero configuration — this is the only provider actually
 * exercised in this step. Output is realistic-shaped (reads real fields
 * out of `input` where present) rather than pure boilerplate, so it's
 * actually useful for testing the "apply to report" flow.
 */
const mockAiProvider = {
  getProviderName() {
    return 'mock';
  },
  isConfigured() {
    return true; // the mock provider needs no configuration at all
  },
  async runAgent({ agentName, prompt, input }) {
    const hash = promptHash(prompt);
    const generator = MOCK_GENERATORS[agentName];
    const output = generator ? generator(input || {}, hash) : { error: `No mock generator for agent "${agentName}".` };

    // A rough, clearly-fake per-character "cost" so the UI has something
    // realistic-shaped to display — never billed, never real money.
    const charCount = prompt.system.length + prompt.user.length;
    const estimatedCost = `$${(charCount * 0.000002).toFixed(6)} (mock estimate)`;

    return { output, estimatedCost, model: 'mock-model-v1' };
  }
};

// ---------------------------------------------------------------------------
// Real OpenAI provider — the only real (non-mock) provider actually
// implemented here. Uses the official `openai` npm SDK. Gated by TWO
// independent conditions, same money-safety pattern as everywhere else
// in this codebase (see VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK,
// PAYMENTS_ENABLED, etc.): a real OPENAI_API_KEY must be set, AND
// AI_MONTHLY_BUDGET_LIMIT must be a positive number an admin deliberately
// set. Neither alone is enough. No retries — one attempt, then either a
// result or a clear, specific error; never an infinite/silent retry loop.
// ---------------------------------------------------------------------------

const OPENAI_REQUEST_TIMEOUT_MS = 30000;

// Rough, clearly-labeled LIST-PRICE estimate for the admin UI — not a
// real invoice figure (actual billing depends on the OpenAI account's
// own rate/tier and can change over time). Unknown models fall back to
// an honest "(unknown)" rather than a guessed number.
const OPENAI_PRICE_PER_1M_TOKENS_USD = {
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 }
};

function findPriceTableEntry(model) {
  if (OPENAI_PRICE_PER_1M_TOKENS_USD[model]) return OPENAI_PRICE_PER_1M_TOKENS_USD[model];
  // OpenAI often returns a dated/versioned model string (e.g.
  // "gpt-4.1-mini-2025-04-14") even when the request asked for the
  // unversioned alias — match by prefix so the price table still applies.
  const key = Object.keys(OPENAI_PRICE_PER_1M_TOKENS_USD).find((k) => model && model.startsWith(k));
  return key ? OPENAI_PRICE_PER_1M_TOKENS_USD[key] : null;
}

function estimateOpenAiCost(model, usage) {
  const prices = findPriceTableEntry(model);
  if (!prices || !usage) return '(unknown — model not in local price table; check the OpenAI dashboard for actual usage/cost)';
  const inputCost = ((usage.prompt_tokens || 0) / 1_000_000) * prices.input;
  const outputCost = ((usage.completion_tokens || 0) / 1_000_000) * prices.output;
  return `~$${(inputCost + outputCost).toFixed(6)} (estimate, list price — not your actual invoice)`;
}

let openaiClientSingleton = null;
/** Constructed lazily (not at module load) so importing this file never
 * touches process.env.OPENAI_API_KEY unless AI_PROVIDER=openai is
 * actually selected and a run is actually attempted. */
function getOpenAiClient() {
  if (!openaiClientSingleton) {
    openaiClientSingleton = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_REQUEST_TIMEOUT_MS, maxRetries: 0 });
  }
  return openaiClientSingleton;
}

function openAiIsConfigured() {
  return !!process.env.OPENAI_API_KEY && AI_MONTHLY_BUDGET_LIMIT > 0;
}

/**
 * Turns an OpenAI SDK error into a safe, specific, human-readable
 * message. Only ever reads `.status`/`.code`/`.message` off the error —
 * never anything that could carry the API key (the SDK's own errors
 * don't include it either, but this stays narrow on purpose regardless).
 */
function describeOpenAiError(err) {
  const status = err && err.status;
  const code = err && (err.code || (err.error && err.error.code));
  if (status === 401) return 'OpenAI rejected the API key (401 Unauthorized) — check that OPENAI_API_KEY in backend/.env is correct and active.';
  if (code === 'insufficient_quota') return 'OpenAI reports insufficient quota/billing on this account (insufficient_quota) — check the OpenAI account\'s billing and usage limits.';
  if (status === 429) return 'OpenAI rate-limited this request (429) — wait before trying again. This is not retried automatically.';
  if (status === 400) return `OpenAI rejected the request as invalid (400): ${err.message || 'no further detail from OpenAI'}.`;
  if (status === 404) return `OpenAI reports the model was not found (404) — check AI_MODEL/OPENAI_MODEL in backend/.env is a real, available model name.`;
  if (err && (err.name === 'APIConnectionTimeoutError' || /timeout/i.test(String(err && err.message)))) {
    return `OpenAI request timed out after ${OPENAI_REQUEST_TIMEOUT_MS}ms.`;
  }
  return `OpenAI request failed${status ? ` (HTTP ${status})` : ''}: ${err && err.message ? err.message : 'unknown error'}.`;
}

const openAiProvider = {
  getProviderName() {
    return 'openai';
  },
  isConfigured: openAiIsConfigured,
  async runAgent({ agentName, prompt }) {
    const model = OPENAI_MODEL || AI_MODEL || 'gpt-4.1-mini';
    const client = getOpenAiClient();

    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        temperature: AI_TEMPERATURE,
        max_tokens: AI_MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ]
      });
    } catch (err) {
      const wrapped = new Error(describeOpenAiError(err));
      wrapped.code = 'PROVIDER_ERROR';
      throw wrapped;
    }

    const rawContent = completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content;
    let output;
    try {
      output = JSON.parse(rawContent || '');
    } catch {
      const err = new Error(`OpenAI returned content that could not be parsed as JSON for agent "${agentName}".`);
      err.code = 'INVALID_OUTPUT';
      throw err;
    }

    return {
      output,
      estimatedCost: estimateOpenAiCost(completion.model || model, completion.usage),
      model: completion.model || model
    };
  }
};

/**
 * Fallback for any AI_PROVIDER value that isn't "mock" or "openai" (e.g.
 * "anthropic", or a typo) — accepted without crashing the backend, but
 * isConfigured() always returns false, so POST /admin/ai/run returns a
 * clear PROVIDER_NOT_CONFIGURED error instead of pretending to call a
 * model that isn't actually wired up here.
 */
function unimplementedProvider(name) {
  return {
    getProviderName() {
      return name;
    },
    isConfigured() {
      return false;
    },
    async runAgent() {
      const err = new Error(`AI_PROVIDER="${name}" is not implemented — only "mock" and "openai" run real agent calls. See backend/README.md's "AI orchestrator foundation" / "GPT API readiness" sections.`);
      err.code = 'PROVIDER_NOT_CONFIGURED';
      throw err;
    }
  };
}

export function getAiProvider() {
  if (AI_PROVIDER_NAME === 'mock') return mockAiProvider;
  if (AI_PROVIDER_NAME === 'openai') return openAiProvider;
  return unimplementedProvider(AI_PROVIDER_NAME);
}

/** Builds a specific "why isn't this configured" message for whichever
 * provider is currently selected — used only by runWithProvider() below
 * when isConfigured() already returned false, so this never duplicates
 * or overrides the isConfigured() check itself, just explains it. */
function describeNotConfigured(providerName) {
  if (providerName === 'openai') {
    const missing = [];
    if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY is not set');
    if (!(AI_MONTHLY_BUDGET_LIMIT > 0)) missing.push('AI_MONTHLY_BUDGET_LIMIT is 0 (or unset) — set a positive monthly budget deliberately before any real call is attempted');
    return `AI_PROVIDER="openai" is not ready: ${missing.join('; ') || 'unknown reason'}. Both a real key and a positive budget are required.`;
  }
  return `AI provider "${providerName}" is not configured or not implemented yet — only "mock" and "openai" run real agent calls.`;
}

/** Thin wrapper orchestrator.js calls — exists so orchestrator.js doesn't
 * need to know about isConfigured()/error-code details itself. */
export async function runWithProvider({ agentName, prompt, input }) {
  const provider = getAiProvider();
  if (!provider.isConfigured()) {
    const err = new Error(describeNotConfigured(provider.getProviderName()));
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }
  const result = await provider.runAgent({ agentName, prompt, input });
  return { ...result, provider: provider.getProviderName(), model: result.model || AI_MODEL || 'unknown' };
}

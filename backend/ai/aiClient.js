import crypto from 'crypto';
import { AI_PROVIDER_NAME, AI_MODEL, AI_MONTHLY_BUDGET_LIMIT } from './aiConfig.js';

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

const MOCK_GENERATORS = {
  listing_analysis: mockListingAnalysis,
  risk_scoring: mockRiskScoring,
  report_writer: mockReportWriter,
  buyer_advisor: mockBuyerAdvisor,
  vin_risk_explanation: mockVinRiskExplanation,
  crm_follow_up: mockCrmFollowUp,
  b2b_sales: mockB2bSales,
  support: mockSupport,
  operations_payment: mockOperationsPayment
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

/**
 * Real providers are NOT implemented in this step — this project has no
 * network access to api.openai.com/api.anthropic.com in this
 * environment, and wiring in a real SDK before it can be genuinely
 * tested would just be more reviewed-but-unverified code (see
 * backend/README.md's honest note about stripeProvider.js for the same
 * situation with payments). Selecting "openai" or "anthropic" via
 * AI_PROVIDER is accepted (doesn't crash the backend), but isConfigured()
 * always returns false until a real implementation exists here — so
 * POST /admin/ai/run returns a clear PROVIDER_NOT_CONFIGURED error
 * instead of pretending to call a model that isn't actually wired up.
 *
 * For AI_PROVIDER=openai specifically, the error message below reports
 * exactly which of the two independent gates isn't satisfied yet
 * (OPENAI_API_KEY missing, and/or AI_MONTHLY_BUDGET_LIMIT still at its
 * default of 0) — both must be true before a real call would even be
 * attempted once this is actually implemented. Neither gate is
 * sufficient by itself: a real key with a zero budget is still refused,
 * and a positive budget with no key is still refused.
 *
 * If/when a real provider is added: it would call a plain fetch() to
 * the provider's chat-completions endpoint with prompt.system/prompt.user,
 * ask for JSON output (most providers support a "JSON mode"), parse the
 * response, and return { output, estimatedCost, model } in the same
 * shape as the mock provider above — orchestrator.js's output-shape
 * validation (see safety/aiGuards.js) applies identically either way,
 * so a real provider returning malformed JSON fails safely the same way
 * a broken mock would.
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
      let message = `AI_PROVIDER="${name}" is not implemented yet in this step — only "mock" runs real agent calls. See backend/README.md's "AI orchestrator foundation" section.`;
      if (name === 'openai') {
        const missing = [];
        if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY is not set');
        if (!(AI_MONTHLY_BUDGET_LIMIT > 0)) missing.push('AI_MONTHLY_BUDGET_LIMIT is 0 (or unset) — a positive monthly budget must be set deliberately before any real call is even considered');
        if (missing.length > 0) {
          message = `AI_PROVIDER="openai" readiness check failed: ${missing.join('; ')}. Also note: even once both are set, no real OpenAI call is implemented in this step yet — see backend/README.md's "GPT API readiness" section.`;
        }
      }
      const err = new Error(message);
      err.code = 'PROVIDER_NOT_CONFIGURED';
      throw err;
    }
  };
}

export function getAiProvider() {
  if (AI_PROVIDER_NAME === 'mock') return mockAiProvider;
  return unimplementedProvider(AI_PROVIDER_NAME);
}

/** Thin wrapper orchestrator.js calls — exists so orchestrator.js doesn't
 * need to know about isConfigured()/error-code details itself. */
export async function runWithProvider({ agentName, prompt, input }) {
  const provider = getAiProvider();
  if (!provider.isConfigured()) {
    const err = new Error(`AI provider "${provider.getProviderName()}" is not configured (missing AI_API_KEY, or provider not implemented yet).`);
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }
  const result = await provider.runAgent({ agentName, prompt, input });
  return { ...result, provider: provider.getProviderName(), model: result.model || AI_MODEL || 'unknown' };
}

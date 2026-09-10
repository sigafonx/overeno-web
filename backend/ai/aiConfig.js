// Central place for AI feature flags — everything else in backend/ai/
// and the AI routes in server.js read these from here instead of
// touching process.env directly. Mirrors backend/payments/paymentConfig.js
// (same "one file owns the flags" pattern for a different feature).

export const AI_ENABLED = String(process.env.AI_ENABLED || 'false').toLowerCase() === 'true';
export const AI_PROVIDER_NAME = (process.env.AI_PROVIDER || 'mock').toLowerCase();
export const AI_MODEL = process.env.AI_MODEL || '';
export const AI_MAX_INPUT_CHARS = Number.isFinite(parseInt(process.env.AI_MAX_INPUT_CHARS, 10))
  ? parseInt(process.env.AI_MAX_INPUT_CHARS, 10)
  : 20000;

// Read for completeness/visibility (e.g. a future startup-log line), but
// deliberately NOT used to decide whether a run needs review — see
// orchestrator.js's own comment on requiresHumanReview for exactly why
// this flag cannot turn review off in this step, regardless of its value.
export const AI_REQUIRE_HUMAN_REVIEW = String(process.env.AI_REQUIRE_HUMAN_REVIEW ?? 'true').toLowerCase() !== 'false';

// --- GPT/OpenAI readiness (see backend/README.md's "GPT API readiness"
// section) — config only, no real OpenAI call is implemented anywhere
// in this codebase yet. OPENAI_API_KEY is provided solely by the
// project owner and only ever lives in backend/.env, never in code,
// never in the frontend, never committed. ---

// Specific to AI_PROVIDER=openai — kept separate from the generic
// AI_MODEL above so a future real implementation has an unambiguous
// default (gpt-4.1-mini) without changing what AI_MODEL means for any
// other provider.
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// Money-safety gate, independent of whether OPENAI_API_KEY is set: a
// real (non-mock) provider is only ever considered "configured" if
// this is a positive number. Defaults to 0 (= not configured) — an
// admin has to deliberately set a real budget before any real provider
// call becomes possible at all, even with a valid API key already in
// place. This is on top of, not instead of, the API-key check itself.
export const AI_MONTHLY_BUDGET_LIMIT = Number.isFinite(parseFloat(process.env.AI_MONTHLY_BUDGET_LIMIT))
  ? parseFloat(process.env.AI_MONTHLY_BUDGET_LIMIT)
  : 0;

// Deliberately NOT exported: the raw API key(s). Only aiClient.js reads
// process.env.AI_API_KEY / process.env.OPENAI_API_KEY directly, and
// only to decide "configured or not" — it never logs the value, never
// returns it in any API response, and nothing outside aiClient.js ever
// sees it.


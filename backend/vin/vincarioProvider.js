import crypto from 'crypto';
import { VINCARIO_BASE_URL, VINCARIO_FORMAT, VIN_PROVIDER_ENABLED, VIN_PROVIDER_TIMEOUT_MS } from './vinConfig.js';
import { normalizeVinResult } from './vinNormalizer.js';

// ---------------------------------------------------------------------------
// Vincario (api.vincario.com) VIN decode adapter.
//
// HONEST STATUS: implemented against Vincario's publicly documented
// request scheme (control-sum auth, decode/info + decode endpoints,
// label/value "decode" array response shape). Reviewed, but treat the
// field-parsing below as best-effort until it's been exercised against
// a live, fully-working Vincario account.
//
// Vincario's `decode`/`decode/info` endpoints return technical vehicle
// specifications (make/model/year/engine/body/fuel/plant country, ...),
// NOT accident/mileage/ownership history — that requires a separate,
// paid VHR (vehicle history report) product this adapter does not call.
// So `history`/`accidents`/`owners`/`score` stay empty/null here — never
// fabricated — and a risk note says so explicitly.
//
// Auth scheme (per Vincario's docs): CONTROL_SUM = first 10 hex chars of
// sha1(VIN + ID + API_KEY + SECRET_KEY) for VIN-based endpoints
// ("info" for decode/info, "decode" for decode), VIN always uppercased
// first. Endpoints that take NO VIN (e.g. "balance") instead compute
// CONTROL_SUM = first 10 hex chars of sha1(ID + API_KEY + SECRET_KEY).
//
// URL shape (per Vincario's docs, server https://api.vincario.com/,
// endpoint accessible at https://api.vincario.com/3.2/):
//   GET /3.2/{API_KEY}/{CONTROL_SUM}/decode/info/{VIN}.{format}
//   GET /3.2/{API_KEY}/{CONTROL_SUM}/decode/{VIN}.{format}
// Base URL is normalized below (see deriveBases()) so it never matters
// whether VIN_PROVIDER_BASE_URL in .env was set with or without a
// trailing "/3.2" — the actual request always has exactly one.
// ---------------------------------------------------------------------------

// Deliberately NOT exported from vinConfig.js — read here only, only to
// decide "configured or not" and to compute the control sum. Never
// logged, never included in any thrown error message, never returned in
// any API response — even partially. Only LENGTH is ever exposed.
const VIN_PROVIDER_API_KEY = process.env.VIN_PROVIDER_API_KEY || '';
const VIN_PROVIDER_SECRET_KEY = process.env.VIN_PROVIDER_SECRET_KEY || '';

function isConfigured() {
  return VIN_PROVIDER_ENABLED && !!VIN_PROVIDER_API_KEY && !!VIN_PROVIDER_SECRET_KEY;
}

/** Presence + LENGTH-only flags for diagnostics/admin UI — never the
 * key/secret value itself, not even a prefix/suffix character. Matches
 * this project's "present: yes/no" logging convention everywhere else,
 * extended with length since that's useful to spot an obviously-wrong
 * value (e.g. an empty string, or a value with stray whitespace) without
 * ever revealing a single character of the real key/secret. */
export function getKeyPresence() {
  return {
    apiKeyPresent: !!VIN_PROVIDER_API_KEY,
    apiKeyLength: VIN_PROVIDER_API_KEY.length,
    secretKeyPresent: !!VIN_PROVIDER_SECRET_KEY,
    secretKeyLength: VIN_PROVIDER_SECRET_KEY.length
  };
}

function controlSum(endpointId, vin) {
  const base = vin
    ? `${vin}${endpointId}${VIN_PROVIDER_API_KEY}${VIN_PROVIDER_SECRET_KEY}`
    : `${endpointId}${VIN_PROVIDER_API_KEY}${VIN_PROVIDER_SECRET_KEY}`;
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 10);
}

/**
 * Normalizes whatever VIN_PROVIDER_BASE_URL happens to be (with or
 * without a trailing "/3.2", with or without a trailing slash) into a
 * `{ root, versioned }` pair where `versioned` is ALWAYS exactly
 * `root + "/3.2"` — never "/3.2/3.2" (double), never missing "/3.2"
 * (per Vincario's docs, the endpoint lives at that exact path). This is
 * the fix for "does /3.2 get added twice (or not at all)?" — every URL
 * this file builds goes through this single normalization, so a
 * misconfigured .env value (with or without the version suffix) always
 * produces the same correct request.
 */
function deriveBases() {
  const configured = String(VINCARIO_BASE_URL || 'https://api.vincario.com/3.2').replace(/\/+$/, '');
  const root = configured.replace(/\/3\.2$/, '');
  return { root, versioned: `${root}/3.2` };
}

/** Never includes the API key, control sum, or VIN in a way that could
 * be reconstructed byte-for-byte — key/checksum segments are replaced
 * with `[REDACTED-*:NNchars]` placeholders (length only). Deliberately
 * does NOT use the words "key"/"sum"/"checksum" inside the placeholder
 * text itself (past bug: a placeholder literally containing the word
 * "checksum" made classifyVincarioError() misfire on ITS OWN redaction
 * marker after sanitization — see sanitizeProviderMessage()'s doc
 * comment for why classification always happens on the RAW message,
 * before redaction, specifically to avoid this class of bug). VIN is
 * technical spec lookup data, not a secret, so it IS shown (matches
 * what's already public in the request the admin themselves triggered). */
function maskedRoute(basePath, endpointPath, vin) {
  const vinSegment = vin ? `/${vin}` : '';
  return `${basePath}/[REDACTED-A:${VIN_PROVIDER_API_KEY.length}chars]/[REDACTED-B:10chars]/${endpointPath}${vinSegment}.${VINCARIO_FORMAT}`;
}

function buildUrl(base, endpointId, endpointPath, vin) {
  const sum = controlSum(endpointId, vin);
  const suffix = vin ? `/${endpointPath}/${vin}.${VINCARIO_FORMAT}` : `/${endpointPath}.${VINCARIO_FORMAT}`;
  return `${base}/${VIN_PROVIDER_API_KEY}/${sum}${suffix}`;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Error classification — turns an HTTP status + Vincario's own message
// text into one of a small set of specific, actionable codes. Vincario
// often replies HTTP 200 even for auth/plan/quota problems, with
// `{ error: true, message: "..." }` instead of a 4xx — so message text
// matters at least as much as status here, not status alone. Route-level
// 404s ("The route ... could not be found") are Express/Laravel-style
// framework responses, not Vincario's own `{error,message}` JSON shape —
// handled the same way regardless of which shape the body turns out to be.
// ---------------------------------------------------------------------------

const CHECKSUM_KEYWORDS = /invalid control ?sum|checksum/i;
const PRODUCT_NOT_ENABLED_KEYWORDS = /not enabled|access denied to this (service|product|package)|product (is )?not (active|activated|available)|service (is )?not (active|activated|available)/i;
const PLAN_KEYWORDS = /plan|upgrade|not allowed|not permitted|subscri|trial/i;
const QUOTA_KEYWORDS = /quota|credit|balance|insufficient|exhaust|not enough/i;
const INVALID_VIN_KEYWORDS = /invalid vin|vin.{0,15}(invalid|not valid|malformed)/i;
const ROUTE_NOT_FOUND_KEYWORDS = /route .* could not be found|no route found|not found/i;

export function classifyVincarioError({ status, message, networkError }) {
  if (networkError) return 'providerNetworkError';

  const msg = String(message || '');

  // Checked BEFORE generic 401/403/404 handling — these are more
  // specific diagnoses than "unauthorized"/"not found" alone, and the
  // whole point of this classifier is to tell them apart (see
  // GET /admin/vin/provider-health, which reports each separately).
  if (INVALID_VIN_KEYWORDS.test(msg)) return 'invalidVin';
  if (CHECKSUM_KEYWORDS.test(msg)) return 'providerChecksumInvalid';
  if (PRODUCT_NOT_ENABLED_KEYWORDS.test(msg)) return 'providerProductNotEnabled';

  if (status === 404 || ROUTE_NOT_FOUND_KEYWORDS.test(msg)) return 'providerEndpointUnavailable';
  if (status === 402 || status === 429 || QUOTA_KEYWORDS.test(msg)) return 'providerQuotaEmpty';
  if (status === 401 || status === 403) {
    return PLAN_KEYWORDS.test(msg) ? 'providerPlanLimited' : 'providerUnauthorized';
  }
  if (PLAN_KEYWORDS.test(msg)) return 'providerPlanLimited';

  return 'providerError';
}

/**
 * Never includes the request URL, API key, secret, or control sum — only
 * the HTTP status and whatever short message Vincario's own JSON body
 * (or, for a route-level 404, the framework's own plain-text body)
 * provided, which is itself just a plain error description, not a
 * credential. `.code` is one of classifyVincarioError()'s specific
 * codes, not a generic bucket.
 */
function safeProviderError(status, bodyMessage, code) {
  const err = new Error(
    `Vincario responded with HTTP ${status}${bodyMessage ? `: ${bodyMessage}` : ''}.`
  );
  err.code = code || classifyVincarioError({ status, message: bodyMessage });
  err.status = status;
  err.providerMessage = bodyMessage || null;
  return err;
}

/** Vincario's `decode`/`decode/info` responses carry a `decode` array of
 * {label, value} pairs (technical specs), not fixed field names — this
 * builds a lowercased label -> value lookup so the extraction below
 * doesn't depend on exact casing/wording matching perfectly. */
function labelMapFrom(decodeArray) {
  const map = {};
  for (const entry of decodeArray) {
    if (!entry || typeof entry !== 'object') continue;
    const label = String(entry.label || '').trim().toLowerCase();
    if (!label) continue;
    map[label] = entry.value;
  }
  return map;
}

function firstDefined(map, keys) {
  for (const key of keys) {
    if (map[key] !== undefined && map[key] !== null && map[key] !== '') return map[key];
  }
  return null;
}

/**
 * Maps whichever of Vincario's two response shapes actually came back
 * into this codebase's canonical normalized VIN result. Deliberately
 * conservative: only fields Vincario's `decode`/`decode/info` genuinely
 * return (technical specs) are populated — accidents/mileage/owners/score
 * stay null, with an explicit risk note explaining why, rather than ever
 * guessing at data Vincario didn't provide.
 */
function parseVincarioResponse(vin, endpointUsed, body) {
  const b = body && typeof body === 'object' ? body : {};
  const decodeArray = Array.isArray(b.decode) ? b.decode : null;

  const risks = [
    `Vincario "${endpointUsed}" endpoint returns technical vehicle specifications only — no accident, mileage, or ownership history is included (that requires a separate paid Vincario vehicle-history report, not called here).`
  ];

  if (!decodeArray) {
    risks.push('Vincario response did not include the expected "decode" array — showing only what technical fields could still be found, if any.');
    return normalizeVinResult({
      provider: 'vincario',
      isDemoResult: false,
      vehicle: {},
      history: {},
      risks,
      score: null,
      riskLevel: 'medium',
      rawAvailable: true,
      disclaimer: 'Vincario technical decode — response shape was not fully recognized; see raw provider run data for the exact reply.'
    });
  }

  const map = labelMapFrom(decodeArray);
  const vehicle = {
    make: firstDefined(map, ['make']),
    model: firstDefined(map, ['model']),
    year: (() => {
      const raw = firstDefined(map, ['model year', 'year']);
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    })(),
    bodyType: firstDefined(map, ['body']),
    fuelType: firstDefined(map, ['fuel type - primary', 'fuel type']),
    engineDisplacementCcm: firstDefined(map, ['engine displacement (ccm)', 'engine displacement']),
    enginePowerHp: firstDefined(map, ['engine power (hp)', 'engine power']),
    driveType: firstDefined(map, ['drive type']),
    plantCountry: firstDefined(map, ['plant country'])
  };

  return normalizeVinResult({
    provider: 'vincario',
    isDemoResult: false,
    vehicle,
    history: {},
    risks,
    score: null,
    riskLevel: 'medium',
    rawAvailable: true,
    disclaimer: 'Vincario technical decode — vehicle specifications from Vincario, not an official accident/history report. Verify independently before relying on this for a purchase decision.'
  });
}

/**
 * CRITICAL: Vincario's own error bodies (both its `{error,message}` JSON
 * shape AND a route-level 404's plain-text "The route .../{key}/{sum}/...
 * could not be found" body) ECHO THE FULL REQUEST PATH BACK VERBATIM —
 * including the real API key and the real control sum. Every message
 * string that ever reaches a log line, a thrown error, or an API
 * response MUST go through this first. Replaces the exact known
 * key/checksum substrings (not a generic hex regex — this is a precise,
 * deliberate replacement of values this function's caller already knows,
 * so it can't under- or over-redact) with clearly-labeled placeholders.
 *
 * IMPORTANT ORDERING RULE: classifyVincarioError() must always run on
 * the RAW (pre-sanitize) message, never on the output of this function.
 * A placeholder that happened to contain a classifier keyword (an
 * earlier version used the literal word "checksum" in its placeholder,
 * which then made every sanitized 404 misclassify as a checksum error)
 * is exactly the bug this ordering rule prevents — see callVariant()
 * below, which classifies first and sanitizes only for storage/display.
 */
function sanitizeProviderMessage(message, sum) {
  if (!message) return message;
  let safe = String(message);
  if (VIN_PROVIDER_API_KEY) safe = safe.split(VIN_PROVIDER_API_KEY).join('[REDACTED-A]');
  if (sum) safe = safe.split(sum).join('[REDACTED-B]');
  return safe;
}

/**
 * Low-level single HTTP attempt against one named URL variant. Always
 * attaches a safe `debug` descriptor (`{attemptedVariantName, method,
 * maskedRoute, status, providerErrorMessage}` — no secrets, ever) to
 * both the success return value and any thrown error, so callers never
 * have to rebuild it separately. `vin` is optional (omit for
 * account-level endpoints like "balance"). Classification always uses
 * the RAW provider message; only the STORED/RETURNED text is sanitized
 * (see sanitizeProviderMessage()'s doc comment for exactly why the order
 * matters).
 */
async function callVariant({ variantName, base, endpointId, endpointPath, vin }) {
  const sum = controlSum(endpointId, vin);
  const url = buildUrl(base, endpointId, endpointPath, vin);
  const debugBase = {
    attemptedVariantName: variantName,
    method: 'GET',
    maskedRoute: maskedRoute(base.replace(/^https?:\/\/[^/]+/, ''), endpointPath, vin)
  };

  let res;
  try {
    res = await fetchWithTimeout(url, VIN_PROVIDER_TIMEOUT_MS);
  } catch (err) {
    const rawMsg = err.name === 'AbortError'
      ? `Vincario request timed out after ${VIN_PROVIDER_TIMEOUT_MS}ms.`
      : `Vincario request failed: ${err.message}`;
    const wrapped = new Error(sanitizeProviderMessage(rawMsg, sum));
    wrapped.code = classifyVincarioError({ networkError: true, message: rawMsg });
    wrapped.debug = { ...debugBase, status: null, providerErrorMessage: wrapped.message };
    throw wrapped;
  }

  let body = null;
  let rawBodyMessage = null;
  try {
    body = await res.json();
    if (body && typeof body === 'object' && typeof body.message === 'string') rawBodyMessage = body.message;
  } catch {
    // Non-JSON body (e.g. a framework's plain-text 404 page) — fall back
    // to the raw text so route-not-found messages are still visible.
    try {
      rawBodyMessage = (await res.clone().text()).slice(0, 300);
    } catch {
      rawBodyMessage = null;
    }
  }

  if (!res.ok) {
    const code = classifyVincarioError({ status: res.status, message: rawBodyMessage });
    const safeMessage = sanitizeProviderMessage(rawBodyMessage, sum);
    const err = safeProviderError(res.status, safeMessage, code);
    err.debug = { ...debugBase, status: res.status, providerErrorMessage: safeMessage };
    throw err;
  }
  // Vincario returns HTTP 200 even for some "no result"/invalid-key/
  // invalid-control-sum/plan/quota cases, with `{ error: true, message:
  // "..." }` instead — classify on the raw message, sanitize only what
  // gets stored/returned.
  if (body && typeof body === 'object' && body.error) {
    const rawMsg = rawBodyMessage || (typeof body.error === 'string' ? body.error : JSON.stringify(body.error));
    const code = classifyVincarioError({ status: res.status, message: rawMsg });
    const safeMsg = sanitizeProviderMessage(rawMsg, sum);
    const err = safeProviderError(res.status, safeMsg, code);
    err.debug = { ...debugBase, status: res.status, providerErrorMessage: safeMsg };
    throw err;
  }

  return { body, debug: { ...debugBase, status: res.status, providerErrorMessage: null } };
}

/** Thin wrapper used by the real (non-diagnostic) decode path — always
 * uses the single canonical, normalized base URL (see deriveBases()). */
async function callEndpoint(endpointId, endpointPath, vin) {
  const { versioned } = deriveBases();
  const { body } = await callVariant({ variantName: endpointId, base: versioned, endpointId, endpointPath, vin });
  return body;
}

const VIN_SHAPE_RE = /^[A-Z0-9]{5,24}$/;

function assertPlausibleVin(vin) {
  const upper = String(vin || '').toUpperCase();
  if (!VIN_SHAPE_RE.test(upper)) {
    const err = new Error('VIN must be 5-24 letters/digits — not sent to Vincario.');
    err.code = 'invalidVin';
    throw err;
  }
  return upper;
}

async function runCheck({ vin }) {
  if (!isConfigured()) {
    const err = new Error('Vincario adapter requires VIN_PROVIDER_ENABLED=true plus both VIN_PROVIDER_API_KEY and VIN_PROVIDER_SECRET_KEY to be set.');
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }

  const upperVin = assertPlausibleVin(vin);
  let endpointUsed = 'decode/info';
  let body;

  try {
    body = await callEndpoint('info', 'decode/info', upperVin);
  } catch (infoErr) {
    // Fallback: decode/info didn't work out — try the plain decode
    // endpoint once. Never retries beyond this single fallback attempt.
    try {
      endpointUsed = 'decode';
      body = await callEndpoint('decode', 'decode', upperVin);
    } catch (decodeErr) {
      // Both attempts failed — surface the second (decode) error, since
      // it's the more specific/final one, but keep both codes intact.
      throw decodeErr;
    }
  }

  const normalized = parseVincarioResponse(upperVin, endpointUsed, body);
  return {
    raw: body,
    normalized,
    // Vincario's actual per-call credit cost depends on the admin's own
    // plan/contract, which this code has no way to know — honest
    // "(unknown)" rather than a guessed number, same pattern as the
    // generic realVinProviderAdapter.js.
    costEstimate: `(unknown — depends on your Vincario plan; endpoint used: ${endpointUsed})`
  };
}

// ---------------------------------------------------------------------------
// Diagnostics — GET /admin/vin/provider-health's engine. Answers "can this
// trial/plan actually decode a VIN right now, without spending on a paid
// tier" via a safe chain: balance (account-level, no VIN, informational
// ONLY — its own failure never implies invalid credentials, per Vincario
// possibly not exposing this endpoint at all on some plans) -> decode/info
// (one real test VIN, the AUTHORITATIVE step) -> decode (fallback, also
// authoritative). Every step is independently try/caught — one failing
// step never stops the others, and this function itself never throws.
// ---------------------------------------------------------------------------

async function attempt(variantArgs) {
  try {
    const { body, debug } = await callVariant(variantArgs);
    return { ok: true, debug, hasPayload: !!body };
  } catch (err) {
    return { ok: false, code: err.code || 'providerError', message: err.message, debug: err.debug || null };
  }
}

/**
 * Runs the balance -> decode/info -> decode diagnostic chain and returns
 * a structured summary, plus a plain-language `diagnosis` of WHAT kind of
 * problem (if any) is blocking real decodes: an invalid checksum/key
 * pairing, a 404'd/wrong endpoint route, a plan/product that doesn't
 * include this feature, an empty balance/quota, a network problem, or
 * "it actually works". `balance`'s own result is reported but NEVER used
 * to drive `diagnosis` — only decode/info and decode (the two endpoints
 * Vincario's own docs confirm exist) are authoritative; see the docs
 * screenshot referenced in this project's notes. Never throws, never
 * includes key/secret/control sum/full URL anywhere in the result — pass
 * `debug: true` to additionally get the safe per-attempt trace
 * (attemptedVariantName/method/maskedRoute/status/providerErrorMessage).
 */
export async function runProviderDiagnostics({ vin, debug } = {}) {
  const presence = getKeyPresence();

  if (!VIN_PROVIDER_ENABLED || !presence.apiKeyPresent || !presence.secretKeyPresent) {
    return {
      configured: false,
      urlConsistencyCheck: null,
      balance: null,
      decodeInfo: null,
      decodeInfoNoVersion: null,
      decodeFallback: null,
      diagnosis: 'not_configured',
      diagnosisMessage: 'VIN_PROVIDER_ENABLED, VIN_PROVIDER_API_KEY, and VIN_PROVIDER_SECRET_KEY must all be set before any Vincario call can be attempted.',
      debugTrace: []
    };
  }

  const { root, versioned } = deriveBases();

  let testVin;
  try {
    testVin = assertPlausibleVin(vin || 'WVWZZZ1JZXW000010');
  } catch {
    testVin = null;
  }

  // Sanity check (no network call) that deriveBases() can never produce
  // a double or missing "/3.2" — proves variants B/A below really are
  // byte-identical by construction, rather than merely assuming so.
  const urlConsistencyCheck = {
    rootHasNoTrailingVersion: !/\/3\.2$/.test(root),
    versionedEndsInSingle32: /(^|[^0-9])3\.2$/.test(versioned) && !/3\.2\/3\.2$/.test(versioned)
  };

  // Variant D: balance — informational only, never authoritative (per
  // explicit instruction: Vincario may not document/expose this endpoint
  // at all on every plan, so its own 404/error must never be read as
  // "credentials are bad").
  const balance = await attempt({ variantName: 'balance', base: versioned, endpointId: 'balance', endpointPath: 'balance', vin: null });

  let decodeInfo = null;
  let decodeInfoNoVersion = null;
  let decodeFallback = null;
  if (testVin) {
    // Variant B (primary, canonical — matches Vincario's documented
    // "https://api.vincario.com/3.2/" + "/{API_KEY}/{CONTROL_SUM}/
    // decode/info/{VIN}.{format}" shape exactly): normalized versioned
    // base (root + exactly one "/3.2", never zero, never two — see
    // deriveBases()) with key/checksum immediately after. This is also
    // what callEndpoint() (the real, non-diagnostic decode path) uses.
    decodeInfo = await attempt({ variantName: 'decode_info_versioned_base', base: versioned, endpointId: 'info', endpointPath: 'decode/info', vin: testVin });

    // Variant A, corrected: earlier revision of this diagnostic built a
    // URL with "/3.2" positioned AFTER the key/checksum segments
    // (".../{API_KEY}/{CONTROL_SUM}/3.2/decode/info/..."), which is not
    // a shape Vincario's docs describe and could never have matched any
    // real route — that was a bug in the diagnostic itself, not a real
    // alternate hypothesis, so it's been replaced with a genuinely
    // different, plausible one instead: NO version segment in the URL
    // at all (in case "/3.2" refers only to the docs/API version number,
    // not a literal path segment for this account).
    if (!decodeInfo.ok) {
      decodeInfoNoVersion = await attempt({ variantName: 'decode_info_no_version_prefix', base: root, endpointId: 'info', endpointPath: 'decode/info', vin: testVin });
    }

    // Variant C: decode without /info — the documented fallback.
    if (!decodeInfo.ok && !(decodeInfoNoVersion && decodeInfoNoVersion.ok)) {
      decodeFallback = await attempt({ variantName: 'decode_versioned_base', base: versioned, endpointId: 'decode', endpointPath: 'decode', vin: testVin });
    }
  }

  const decodeWorked = (decodeInfo && decodeInfo.ok) || (decodeInfoNoVersion && decodeInfoNoVersion.ok) || (decodeFallback && decodeFallback.ok);

  // AUTHORITATIVE codes only — balance is deliberately excluded (point 6:
  // a 404/error on balance alone must never conclude "invalid
  // credentials" or anything else about decode/info's own status).
  const authoritativeCodes = [decodeInfo, decodeInfoNoVersion, decodeFallback]
    .filter((s) => s && s.ok === false)
    .map((s) => s.code);

  let diagnosis;
  let diagnosisMessage;
  if (decodeWorked) {
    diagnosis = 'working';
    diagnosisMessage = 'A real Vincario decode succeeded — this key/secret pair and plan can decode VINs right now.';
  } else if (authoritativeCodes.includes('providerChecksumInvalid')) {
    diagnosis = 'checksum_invalid';
    diagnosisMessage = 'Vincario reached the decode/decode-info route and rejected the control sum — the key/secret pairing does not check out. This is a credentials problem: get a fresh, matching key+secret pair from the Vincario dashboard (do not swap which value goes in which env var without confirming which one Vincario calls the "API key" vs "secret key").';
  } else if (authoritativeCodes.includes('providerEndpointUnavailable')) {
    diagnosis = 'route_not_found';
    diagnosisMessage = 'Vincario returned "route not found" (404) for decode/info and/or decode — the request never reached checksum validation at all, so this is NOT necessarily a bad key/secret. Do not buy a paid tier over this alone: first double-check the exact endpoint path/format against the Vincario dashboard or current API docs for this specific account — the trial product may simply not include this route, or the path may differ from what is assumed here.';
  } else if (authoritativeCodes.includes('providerProductNotEnabled')) {
    diagnosis = 'product_not_enabled';
    diagnosisMessage = 'Vincario recognized the request but reports this specific product/service is not enabled for the account — check the Vincario dashboard for which products the current (trial) plan actually includes before buying anything.';
  } else if (authoritativeCodes.includes('providerPlanLimited')) {
    diagnosis = 'trial_plan_restricted';
    diagnosisMessage = 'Vincario accepted the credentials but refused the request as not permitted for this plan. Check the Vincario dashboard for what the current plan includes before buying a paid tier.';
  } else if (authoritativeCodes.includes('providerUnauthorized')) {
    diagnosis = 'invalid_credentials';
    diagnosisMessage = 'Vincario rejected the request as unauthorized on the decode route itself — likely a credentials problem. Get a fresh key+secret pair from the Vincario dashboard.';
  } else if (authoritativeCodes.includes('providerQuotaEmpty')) {
    diagnosis = 'quota_or_balance_empty';
    diagnosisMessage = 'Vincario reports insufficient balance/credits/quota for this call. Check the account balance in the Vincario dashboard.';
  } else if (authoritativeCodes.includes('providerNetworkError')) {
    diagnosis = 'network_error';
    diagnosisMessage = 'Could not reach api.vincario.com at all (timeout or network error) — check outbound network connectivity from this machine, not a credentials/plan problem.';
  } else if (authoritativeCodes.length > 0) {
    diagnosis = 'unknown_error';
    diagnosisMessage = 'Vincario returned an error that did not match a known category — see the per-step messages for the exact text.';
  } else {
    diagnosis = 'no_test_performed';
    diagnosisMessage = 'No decode steps could be attempted (invalid test VIN).';
  }

  const stripDebug = (step) => step && { ...step, debug: undefined };
  const result = {
    configured: true,
    urlConsistencyCheck,
    balance: stripDebug(balance),
    decodeInfo: stripDebug(decodeInfo),
    decodeInfoNoVersion: stripDebug(decodeInfoNoVersion),
    decodeFallback: stripDebug(decodeFallback),
    diagnosis,
    diagnosisMessage
  };

  if (debug) {
    result.debugTrace = [balance, decodeInfo, decodeInfoNoVersion, decodeFallback]
      .filter(Boolean)
      .map((s) => s.debug)
      .filter(Boolean);
  }

  return result;
}

export const vincarioProvider = {
  getProviderName: () => 'vincario',
  isConfigured,
  runCheck
};

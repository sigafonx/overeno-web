import { VIN_API_BASE_URL, VIN_PROVIDER_TIMEOUT_MS } from './vinConfig.js';
import { normalizeVinResult } from './vinNormalizer.js';

// Deliberately NOT exported from vinConfig.js — only read here, only to
// decide "configured or not". Never logged, never returned in any API
// response.
const VIN_API_KEY = process.env.VIN_API_KEY || '';

// ---------------------------------------------------------------------------
// HONEST STATUS: this adapter has NOT been exercised against a real VIN
// provider API in this environment — there is no network access to any
// real vehicle-history provider here, and no real API credentials were
// available. The field-extraction logic below is a best-effort, generic
// mapping (tries several common field-name conventions) since there is
// no specific provider's documented schema to code against yet. Treat
// this as reviewed-but-unverified — same honest framing as
// stripeProvider.js and aiClient.js's real-provider stubs elsewhere in
// this codebase (see backend/README.md). Before using this for real:
// (1) pick a specific, ToS-compliant VIN/vehicle-history API, (2) adjust
// parseProviderResponse() below to that API's actual documented
// response shape, (3) test against their sandbox if they offer one.
// ---------------------------------------------------------------------------

/**
 * Best-effort generic extraction from a provider's JSON response body
 * into the canonical normalized shape — tries a handful of common
 * field-name conventions (snake_case and camelCase) since there's no
 * specific real provider's schema to target yet. `isDemoResult` is
 * passed in explicitly by the caller (true for mock_real, false for a
 * genuine real response) rather than inferred from the body, so this
 * function can't accidentally mislabel simulated data as real or vice
 * versa.
 */
function parseProviderResponse(providerName, body, isDemoResult) {
  const b = body && typeof body === 'object' ? body : {};

  const year = b.year ?? b.vehicle_year ?? b.modelYear ?? null;
  const mileage = b.mileage ?? b.odometer ?? (Array.isArray(b.odometer_readings) && b.odometer_readings[0] ? b.odometer_readings[0].mileage : null);
  const accidentsRaw = b.accidents ?? b.accident_count ?? (Array.isArray(b.accident_records) ? b.accident_records.length : null);
  const owners = b.owners ?? b.owner_count ?? b.ownerCount ?? null;
  const titleStatus = b.title_status ?? b.titleStatus ?? null;
  const scoreRaw = b.score ?? b.risk_score ?? b.riskScore ?? null;

  const risks = [];
  if (titleStatus && String(titleStatus).toLowerCase() !== 'clean') {
    risks.push(`Title status reported as "${titleStatus}".`);
  }
  if (accidentsRaw && Number(accidentsRaw) > 0) {
    risks.push(`${accidentsRaw} accident record(s) reported by the provider.`);
  }

  return normalizeVinResult({
    provider: providerName,
    isDemoResult,
    vehicle: { year, mileage },
    history: { accidents: accidentsRaw, owners, titleStatus },
    risks,
    score: scoreRaw,
    riskLevel: scoreRaw !== null ? (scoreRaw < 45 ? 'high' : scoreRaw < 72 ? 'medium' : 'low') : 'medium',
    rawAvailable: true,
    disclaimer: isDemoResult
      ? 'Simulated (mock_real) response — no real provider was called, this does not reflect any real vehicle.'
      : undefined // let normalizeVinResult fill in its own default disclaimer for a genuine real response
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// --- "real" provider: actual HTTP call -------------------------------------

function realIsConfigured() {
  return !!(VIN_API_BASE_URL && VIN_API_KEY);
}

async function realRunCheck({ vin }) {
  if (!realIsConfigured()) {
    const err = new Error('VIN_PROVIDER=real requires both VIN_API_BASE_URL and VIN_API_KEY to be set.');
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }

  let res;
  try {
    res = await fetchWithTimeout(
      `${VIN_API_BASE_URL}${VIN_API_BASE_URL.includes('?') ? '&' : '?'}vin=${encodeURIComponent(vin)}`,
      { headers: { Authorization: `Bearer ${VIN_API_KEY}`, Accept: 'application/json' } },
      VIN_PROVIDER_TIMEOUT_MS
    );
  } catch (err) {
    const wrapped = new Error(
      err.name === 'AbortError'
        ? `VIN provider request timed out after ${VIN_PROVIDER_TIMEOUT_MS}ms.`
        : `VIN provider request failed: ${err.message}`
    );
    wrapped.code = 'PROVIDER_ERROR';
    throw wrapped;
  }

  if (!res.ok) {
    const err = new Error(`VIN provider responded with HTTP ${res.status}.`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    const err = new Error('VIN provider response was not valid JSON.');
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  const normalized = parseProviderResponse('real', body, false);
  return {
    raw: body,
    normalized,
    // Real per-call cost depends entirely on whichever provider/contract
    // is eventually configured — this codebase has no way to know that
    // number, so it's honest about not knowing rather than guessing.
    costEstimate: '(unknown — depends on your real VIN provider\'s pricing/contract)'
  };
}

export const realVinProvider = {
  getProviderName: () => 'real',
  isConfigured: realIsConfigured,
  runCheck: realRunCheck
};

// --- "mock_real" provider: no network, tests the SAME parsing pipeline -----

function mockHashVin(vin) {
  let h = 0;
  for (let i = 0; i < vin.length; i++) {
    h = (h * 31 + vin.charCodeAt(i)) >>> 0;
  }
  return h;
}

function mockRealIsConfigured() {
  return true; // no configuration needed — that's the point of this mode
}

/**
 * Simulates a plausible real-provider JSON response (a guess at what
 * one might send, not any specific real API's actual schema) and runs
 * it through the exact same parseProviderResponse() the real path uses
 * — this proves the field-extraction/normalization code works
 * end-to-end without needing real network access or credentials.
 * Deterministic (same VIN -> same simulated response), and the output
 * is always explicitly marked isDemoResult: true — this is a pipeline
 * test, never real vehicle data.
 */
async function mockRealRunCheck({ vin }) {
  const h = mockHashVin(vin);
  const rawBody = {
    vin,
    vehicle_year: 2012 + (h % 13),
    odometer_readings: [{ mileage: 50000 + (h % 150000), source: 'mock_real_simulation' }],
    accident_records: Array.from({ length: h % 3 }, (_, i) => ({ date: `202${i}-01-01`, severity: 'minor' })),
    owner_count: 1 + (h % 3),
    title_status: h % 10 === 0 ? 'salvage' : 'clean',
    risk_score: Math.max(20, 100 - (h % 80))
  };

  const normalized = parseProviderResponse('mock_real', rawBody, true);
  return { raw: rawBody, normalized, costEstimate: '$0.00 (mock_real — simulated response, no real provider called)' };
}

export const mockRealVinProvider = {
  getProviderName: () => 'mock_real',
  isConfigured: mockRealIsConfigured,
  runCheck: mockRealRunCheck
};

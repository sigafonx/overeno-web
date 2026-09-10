import { normalizeVinResult } from './vinNormalizer.js';

// ---------------------------------------------------------------------------
// This is the SAME deterministic pseudo-random generator server.js used
// inline before this step — hashVin()/generateVinResult() are copied
// here byte-for-byte (not rewritten), specifically so POST /vin/check's
// existing behavior cannot change: same VIN in, same numbers out, same
// as before this refactor. server.js now imports generateVinResult from
// here instead of defining it locally — see this file's exports.
// ---------------------------------------------------------------------------

function hashVin(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Deterministic pseudo-random DEMO result — same VIN always produces the
 * same numbers. This is not a real vehicle history lookup; every response
 * is clearly marked isDemoResult: true and carries a disclaimer. Used
 * directly by POST /vin/check (the public form) regardless of
 * VIN_PROVIDER — the public form NEVER calls a real, possibly-billed
 * provider; see backend/README.md's "Real VIN provider adapter" section
 * for exactly why.
 */
export function generateVinResult(vin) {
  const h = hashVin(vin);

  const year = 2013 + (h % 12);
  const estimatedMileage = 62000 + (h % 165000);
  const advertisedDiff = (h >> 3) % 28000;
  const advertisedMileage = Math.max(15000, estimatedMileage - advertisedDiff);
  const accidents = h % 3;
  const owners = 1 + (h % 4);
  const riskPct = h % 100;
  const score = Math.max(18, Math.min(97, 100 - riskPct - accidents * 9));

  let odometerRisk = 'low';
  if (riskPct > 60) odometerRisk = 'high';
  else if (riskPct > 30) odometerRisk = 'medium';

  let riskLevel = 'low';
  let verdictKey = 'verdict_good';
  if (score < 45) {
    riskLevel = 'high';
    verdictKey = 'verdict_bad';
  } else if (score < 72) {
    riskLevel = 'medium';
    verdictKey = 'verdict_warn';
  }

  return {
    score,
    riskLevel,
    year,
    estimatedMileage,
    advertisedMileage,
    accidents,
    owners,
    odometerRisk,
    verdictKey,
    isDemoResult: true,
    disclaimer: 'Demo result. Not an official vehicle history report.'
  };
}

// ---------------------------------------------------------------------------
// New provider-interface surface — used by the admin "Run VIN provider"
// flow (POST /admin/vin-checks/:id/run-provider) and the vinProvider.js
// factory, NOT by the public POST /vin/check route (which calls
// generateVinResult() above directly, unchanged). Lets the admin run the
// demo provider through the same uniform interface real/mock_real use,
// for consistency and testing — always free, always instant, always
// clearly marked as demo.
// ---------------------------------------------------------------------------

function getProviderName() {
  return 'demo';
}

function isConfigured() {
  return true; // the demo provider needs no configuration at all
}

async function runCheck({ vin }) {
  const flat = generateVinResult(vin);

  const normalized = normalizeVinResult({
    provider: 'demo',
    isDemoResult: true,
    vehicle: { year: flat.year, estimatedMileage: flat.estimatedMileage, advertisedMileage: flat.advertisedMileage },
    history: { accidents: flat.accidents, owners: flat.owners, odometerRisk: flat.odometerRisk },
    risks: flat.odometerRisk !== 'low' ? [`Odometer risk flagged as "${flat.odometerRisk}" (demo data).`] : [],
    score: flat.score,
    riskLevel: flat.riskLevel,
    rawAvailable: false,
    disclaimer: flat.disclaimer
  });

  return { raw: flat, normalized, costEstimate: '$0.00 (demo — no real provider called)' };
}

export const demoVinProvider = {
  getProviderName,
  isConfigured,
  runCheck
};

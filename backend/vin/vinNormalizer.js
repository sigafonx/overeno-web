// Normalizes ANY VIN provider's output (demo, mock_real, or a real
// provider's actual response) into one canonical shape — this is what
// lets the rest of the product (admin UI, any future report-writing
// logic) work with a single predictable structure regardless of which
// provider actually ran, and it's the safety net that stops a
// malformed/unexpected real-provider response from producing broken
// data: every field is validated/defaulted here, nothing is trusted
// as-is from a provider's raw response.

const DEFAULT_DISCLAIMER = 'This result has not been independently verified. It does not guarantee the accuracy or completeness of the vehicle\'s history.';

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeRiskLevel(value) {
  const v = typeof value === 'string' ? value.toLowerCase().trim() : '';
  return ['low', 'medium', 'high'].includes(v) ? v : 'medium';
}

function normalizePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Coerces a provider's (possibly loosely-shaped) result into the exact
 * canonical shape every consumer of VIN data in this codebase can rely
 * on:
 *   { provider, isDemoResult, vehicle, history, risks, score, riskLevel,
 *     rawAvailable, disclaimer }
 * Never throws — anything missing/malformed is defaulted to a safe
 * empty/neutral value rather than propagating undefined/garbage further
 * into the product. `isDemoResult` defaults to `true` (the SAFER
 * default: if a provider's own signal is ambiguous, treat the result as
 * demo/unverified rather than accidentally presenting unverified data
 * as official).
 */
export function normalizeVinResult(input) {
  const src = input && typeof input === 'object' ? input : {};

  return {
    provider: typeof src.provider === 'string' && src.provider ? src.provider : 'unknown',
    isDemoResult: src.isDemoResult === false ? false : true,
    vehicle: normalizePlainObject(src.vehicle),
    history: normalizePlainObject(src.history),
    risks: normalizeArray(src.risks),
    score: clampScore(src.score),
    riskLevel: normalizeRiskLevel(src.riskLevel),
    rawAvailable: !!src.rawAvailable,
    disclaimer: typeof src.disclaimer === 'string' && src.disclaimer.trim() ? src.disclaimer : DEFAULT_DISCLAIMER
  };
}

export { DEFAULT_DISCLAIMER };

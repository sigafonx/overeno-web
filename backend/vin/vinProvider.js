import { demoVinProvider } from './demoVinProvider.js';
import { realVinProvider, mockRealVinProvider } from './realVinProviderAdapter.js';
import { vincarioProvider } from './vincarioProvider.js';
import { VIN_PROVIDER_NAME, VIN_PROVIDER_ENABLED } from './vinConfig.js';

/**
 * Every provider implements exactly this shape:
 *   getProviderName(): string
 *   isConfigured(): boolean
 *   runCheck({ vin }) -> Promise<{ raw: object, normalized: object, costEstimate: string }>
 *
 * server.js and backend/vin/vinCostLogger.js only ever call through this
 * factory — they never import demoVinProvider.js/realVinProviderAdapter.js
 * directly, so adding a real provider later (once one is actually picked
 * and tested) means changing realVinProviderAdapter.js's field-mapping
 * logic only, nothing else in this codebase changes shape.
 *
 * Unknown VIN_PROVIDER values fall back to "demo" — the safe default —
 * rather than throwing at import time; POST /vin/check must never be
 * taken down by a typo in an env var it doesn't even directly control.
 *
 * VIN_PROVIDER=real specifically prefers the Vincario adapter
 * (vincarioProvider.js) when it's actually usable — VIN_PROVIDER_ENABLED
 * AND both VIN_PROVIDER_API_KEY/VIN_PROVIDER_SECRET_KEY set — and falls
 * back to the older generic Bearer-token adapter (realVinProviderAdapter.js)
 * otherwise, so nothing that was already relying on VIN_API_BASE_URL/
 * VIN_API_KEY changes behavior. Exactly one of the two ever runs for a
 * given request; never both.
 */
export function getVinProvider() {
  if (VIN_PROVIDER_NAME === 'real') {
    if (VIN_PROVIDER_ENABLED && vincarioProvider.isConfigured()) return vincarioProvider;
    return realVinProvider;
  }
  if (VIN_PROVIDER_NAME === 'mock_real') return mockRealVinProvider;
  return demoVinProvider;
}

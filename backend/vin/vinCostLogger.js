import { getVinProvider } from './vinProvider.js';
import { insertVinProviderRun, updateVinProviderRunResult } from '../db/repositories/vinProviderRunsRepository.js';

/**
 * Runs the currently-configured VIN provider against one VIN and
 * persists the full lifecycle to vin_provider_runs — a `running` row
 * first (so even a crash mid-call or a real provider timing out leaves
 * a visible trail), then `completed` with the raw response + normalized
 * result + cost estimate, or `failed` with the error message. This is
 * the ONLY place in the codebase that actually calls
 * getVinProvider().runCheck() — server.js's admin route calls this
 * function, never the provider directly, so every real (or simulated)
 * provider call is guaranteed to be logged, no matter which route ends
 * up triggering one in the future.
 *
 * Throws with a `.code` on failure (PROVIDER_NOT_CONFIGURED,
 * PROVIDER_ERROR, or whatever the provider itself threw) — the caller
 * (server.js) maps `.code` to an HTTP status, same pattern as
 * paymentService.createCheckout() and ai/orchestrator.js's runAgent().
 */
export async function runVinProviderCheck({ vinCheckId, vin }) {
  const provider = getVinProvider();
  const requestJson = JSON.stringify({ vin });

  const run = insertVinProviderRun({
    vinCheckId,
    provider: provider.getProviderName(),
    requestJson
  });

  try {
    const result = await provider.runCheck({ vin });
    return updateVinProviderRunResult(run.id, {
      status: 'completed',
      responseJson: JSON.stringify(result.raw),
      normalizedJson: JSON.stringify(result.normalized),
      costEstimate: result.costEstimate
    });
  } catch (err) {
    updateVinProviderRunResult(run.id, { status: 'failed', errorMessage: err.message });
    throw err;
  }
}

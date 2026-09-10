// ---------------------------------------------------------------------------
// API layer.
//
//   checkVin()        -> talks to a REAL backend (POST /vin/check).
//   createBooking()    -> talks to a REAL backend (POST /bookings).
//   submitLead()        -> talks to a REAL backend (POST /leads).
//
// All three fall back to a client-side mock when the backend is
// unreachable (e.g. no backend running during frontend-only dev). See
// each function's own comment below for exactly how that fallback works.
// ---------------------------------------------------------------------------

// Reads the backend URL from window.OVERENO_CONFIG (set by js/config.js,
// loaded as a plain <script> before this module — see that file for the
// full explanation). Falls back to the same localhost default if
// js/config.js failed to load or was removed, so local dev never breaks
// even without it: `<script src="js/config.js">` missing from a page, or
// the file itself missing, both degrade to this same default rather than
// throwing.
const API_BASE_URL = (window.OVERENO_CONFIG && window.OVERENO_CONFIG.apiBaseUrl) || 'http://localhost:3001';

// Falls back to the client-side mock ONLY when the backend is unreachable
// (connection refused, backend not started, offline, etc.) — not when the
// backend is reachable but rejects the request as invalid.
//
// ⚠️ PRODUCTION: this MUST be set to `false` before deploying for real.
// With it `true`, a backend outage is invisible to users — forms report
// success while silently saving nothing server-side. That's the right
// trade-off for local/offline development, and the wrong one anywhere
// real leads/bookings/payments need to actually land in the database.
const DEV_MOCK_FALLBACK = true;

function hashVin(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Deterministic pseudo-random demo result derived from the VIN string, so
 * the same VIN always produces the same result. This is the client-side
 * mirror of the backend's own generateVinResult() in server.js — same
 * math, so the "flavor" of demo data stays consistent whether the backend
 * is reachable or not. Shape matches the real backend's `result` object
 * exactly, so VinDemo.js never needs to care which one answered.
 */
function generateVinResultLocally(vin) {
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

/**
 * Client-side mock VIN check — kept as the fallback path for when the
 * real backend isn't reachable (see checkVin() below). Return shape
 * matches the real backend's response exactly: { ok, id, status, result }.
 */
async function checkVinMock(vinRaw) {
  const vin = vinRaw.trim().toUpperCase();
  await new Promise((resolve) => setTimeout(resolve, randomDelayMs(150, 400)));
  return {
    ok: true,
    id: 'vincheck-' + Date.now(),
    status: 'completed',
    result: generateVinResultLocally(vin)
  };
}

/**
 * VIN check — used by VinDemo's form.
 *
 * Tries POST {API_BASE_URL}/vin/check first. If the backend responds (even
 * with a validation error, e.g. disallowed characters), that response is
 * what the caller gets. Only falls back to the client-side mock when the
 * backend can't be reached at all (fetch throws TypeError) and
 * DEV_MOCK_FALLBACK is true — same pattern as submitLead()/createBooking().
 */
export async function checkVin(vinRaw) {
  const payload = {
    vin: vinRaw,
    language: document.documentElement.lang || 'unknown',
    source: 'vin_demo',
    pageUrl: window.location.href,
    createdAtClient: new Date().toISOString()
  };

  try {
    const res = await fetch(`${API_BASE_URL}/vin/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON response body — fall through, res.ok check below still applies.
    }

    if (!res.ok) {
      const message = (data && data.message) || `Request failed with status ${res.status}.`;
      throw new Error(message);
    }

    return data;
  } catch (err) {
    if (DEV_MOCK_FALLBACK && err instanceof TypeError) {
      console.warn('[api] POST /vin/check unreachable — falling back to the client-side mock for local dev.');
      return checkVinMock(vinRaw);
    }
    throw err;
  }
}

/**
 * Client-side mock booking creation — kept as the fallback path for when
 * the real backend isn't reachable (see createBooking() below).
 */
async function createBookingMock(payload) {
  await new Promise((resolve) => setTimeout(resolve, randomDelayMs(400, 800)));
  return { ok: true, id: 'booking-' + Date.now(), status: 'new', message: 'Booking saved successfully', ...payload };
}

/**
 * Booking creation — used by BookingModal's "order an inspector" form.
 *
 * Same reachability logic as submitLead(): tries POST {API_BASE_URL}/bookings
 * first and returns whatever the backend says (success or a real validation
 * error). Only falls back to the client-side mock when the backend itself
 * can't be reached (fetch throws TypeError) and DEV_MOCK_FALLBACK is true.
 */
export async function createBooking(payload) {
  try {
    const res = await fetch(`${API_BASE_URL}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON response body — fall through, res.ok check below still applies.
    }

    if (!res.ok) {
      const message = (data && data.message) || `Request failed with status ${res.status}.`;
      throw new Error(message);
    }

    return data;
  } catch (err) {
    if (DEV_MOCK_FALLBACK && err instanceof TypeError) {
      console.warn('[api] POST /bookings unreachable — falling back to the client-side mock for local dev.');
      return createBookingMock(payload);
    }
    throw err;
  }
}

const PARTNER_LEAD_TYPES = ['dealer_request', 'inspector_request'];

function isValidEmailFormat(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Validation rules:
 * - every lead needs a usable email (this alone covers the pre-existing
 *   final-CTA lead, which only ever sends { source, email });
 * - dealer_request / inspector_request additionally need contactName + city;
 * - dealer_request additionally needs companyName.
 * Returns an array of human-readable problem strings (empty array = valid).
 */
function validateLeadPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return ['Missing lead payload.'];
  }

  const problems = [];

  if (!isValidEmailFormat(payload.email)) {
    problems.push('A valid email is required.');
  }

  if (PARTNER_LEAD_TYPES.includes(payload.type)) {
    if (!payload.contactName || !String(payload.contactName).trim()) {
      problems.push('contactName is required.');
    }
    if (!payload.city || !String(payload.city).trim()) {
      problems.push('city is required.');
    }
    if (payload.type === 'dealer_request' && (!payload.companyName || !String(payload.companyName).trim())) {
      problems.push('companyName is required for dealer_request.');
    }
  }

  return problems;
}

function randomDelayMs(min, max) {
  return min + Math.random() * (max - min);
}

function generateLeadId() {
  return 'lead_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Client-side mock lead submission — kept as the fallback path for when
 * the real backend isn't reachable (see submitLead() below).
 */
async function submitLeadMock(payload) {
  await new Promise((resolve) => setTimeout(resolve, randomDelayMs(400, 800)));

  const problems = validateLeadPayload(payload);
  if (problems.length > 0) {
    throw new Error(problems.join(' '));
  }

  // Small random failure, ONLY for the two partner-request lead types, so the
  // UI's error state is reachable during manual QA without deliberately
  // bypassing validation. Does not affect the final-CTA lead.
  if (PARTNER_LEAD_TYPES.includes(payload.type) && Math.random() < 0.12) {
    throw new Error('Simulated server error.');
  }

  return {
    ok: true,
    id: generateLeadId(),
    type: payload.type,
    status: 'new',
    message: 'Lead submitted successfully'
  };
}

/**
 * Lead submission — used by the final CTA email capture and by the
 * Partners dealer/inspector request forms.
 *
 * Tries POST {API_BASE_URL}/leads first. If the backend responds (even
 * with a validation error), that response is what the caller gets — a
 * reachable backend's answer is never overridden by the mock. Only when
 * the backend can't be reached at all (fetch itself throws a TypeError —
 * connection refused, backend not started, offline, CORS misconfigured)
 * does this fall back to the old client-side mock, and only while
 * DEV_MOCK_FALLBACK is true.
 */
export async function submitLead(payload) {
  try {
    const res = await fetch(`${API_BASE_URL}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON response body — fall through, res.ok check below still applies.
    }

    if (!res.ok) {
      const message = (data && data.message) || `Request failed with status ${res.status}.`;
      throw new Error(message);
    }

    return data;
  } catch (err) {
    if (DEV_MOCK_FALLBACK && err instanceof TypeError) {
      console.warn('[api] POST /leads unreachable — falling back to the client-side mock for local dev.');
      return submitLeadMock(payload);
    }
    // Either a real validation/server error from a reachable backend, or
    // the fallback is disabled — let the caller's catch block handle it.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Admin helpers — used only by admin-leads.html / js/admin/admin-leads.js.
// No mock fallback here on purpose: there's nothing meaningful to fake for
// an internal ops screen, so an unreachable backend should surface as a
// real, visible error instead of pretending to have data.
// ---------------------------------------------------------------------------

const ADMIN_PASSWORD_HEADER = 'x-admin-password';

async function adminRequest(path, { method = 'GET', password, body } = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [ADMIN_PASSWORD_HEADER]: password || ''
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (shouldn't normally happen) — res.ok check below still applies.
  }

  if (!res.ok) {
    const message = (data && data.message) || `Request failed with status ${res.status}.`;
    const err = new Error(message);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }

  return data;
}

/** GET /admin/leads with optional { type, status, search, limit, offset }. */
export async function adminFetchLeads(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/leads${query ? '?' + query : ''}`, { password });
}

/** GET /admin/leads/:id */
export async function adminFetchLead(id, password) {
  return adminRequest(`/admin/leads/${encodeURIComponent(id)}`, { password });
}

/** PATCH /admin/leads/:id/status */
export async function adminUpdateLeadStatus(id, status, password) {
  return adminRequest(`/admin/leads/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    password,
    body: { status }
  });
}

/** PATCH /admin/leads/:id/note */
export async function adminUpdateLeadNote(id, internalNote, password) {
  return adminRequest(`/admin/leads/${encodeURIComponent(id)}/note`, {
    method: 'PATCH',
    password,
    body: { internalNote }
  });
}

/** DELETE /admin/leads/:id */
export async function adminDeleteLead(id, password) {
  return adminRequest(`/admin/leads/${encodeURIComponent(id)}`, { method: 'DELETE', password });
}

/**
 * GET /admin/leads/export.csv — returns a Blob (a plain <a href> download
 * link can't attach the x-admin-password header, so this fetches manually
 * and the caller turns the Blob into a download via a temporary object URL).
 */
export async function adminExportLeadsCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  const res = await fetch(`${API_BASE_URL}/admin/leads/export.csv${query ? '?' + query : ''}`, {
    headers: { [ADMIN_PASSWORD_HEADER]: password || '' }
  });

  if (!res.ok) {
    let message = `Export failed with status ${res.status}.`;
    try {
      const data = await res.json();
      if (data && data.message) message = data.message;
    } catch {
      // ignore — keep the generic message
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return res.blob();
}

// ---------------------------------------------------------------------------
// Admin helpers — VIN checks (read-only: no PATCH/DELETE exist on the
// backend for these yet). Used only by admin-vin-checks.html.
// ---------------------------------------------------------------------------

/** GET /admin/vin-checks with optional { riskLevel, search, limit, offset }. */
export async function adminFetchVinChecks(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/vin-checks${query ? '?' + query : ''}`, { password });
}

/** GET /admin/vin-checks/:id */
export async function adminFetchVinCheck(id, password) {
  return adminRequest(`/admin/vin-checks/${encodeURIComponent(id)}`, { password });
}

/** PATCH /admin/vin-checks/:id/note — response is { ok, vinCheck } (not
 * { ok, item } like the other PATCH endpoints — matches the endpoint's
 * own spec), so this returns the raw parsed response rather than just
 * the record, and the caller reads `.vinCheck` itself. */
export async function adminUpdateVinCheckNote(id, internalNote, password) {
  return adminRequest(`/admin/vin-checks/${encodeURIComponent(id)}/note`, {
    method: 'PATCH',
    password,
    body: { internalNote }
  });
}

/** GET /admin/vin-checks/export.csv — same Blob pattern as adminExportLeadsCsv(). */
export async function adminExportVinChecksCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  const res = await fetch(`${API_BASE_URL}/admin/vin-checks/export.csv${query ? '?' + query : ''}`, {
    headers: { [ADMIN_PASSWORD_HEADER]: password || '' }
  });

  if (!res.ok) {
    let message = `Export failed with status ${res.status}.`;
    try {
      const data = await res.json();
      if (data && data.message) message = data.message;
    } catch {
      // ignore — keep the generic message
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return res.blob();
}

// ---------------------------------------------------------------------------
// Payments — used only by the small test-checkout button (see FinalCTA.js).
// No mock fallback here on purpose: unlike submitLead/createBooking/checkVin,
// this is explicitly a dev/test feature, so if payments are disabled or the
// backend is unreachable, the caller should see that plainly rather than
// have it silently pretend to succeed.
// ---------------------------------------------------------------------------

/**
 * POST /payments/checkout. Price is never sent from here — only
 * productCode/entityType/entityId/customerEmail/customerName go in the
 * payload; the backend looks the price up itself from products.js.
 */
export async function createPaymentCheckout(payload) {
  const res = await fetch(`${API_BASE_URL}/payments/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response body — fall through, res.ok check below still applies.
  }

  if (!res.ok) {
    const message = (data && data.message) || `Request failed with status ${res.status}.`;
    throw new Error(message);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Agents — used by admin-leads.html and admin-vin-checks.html to populate
// their "Assigned agent" dropdown and save an assignment. admin-agents.html
// itself is self-contained and does not use these (it needs the full CRUD
// surface, not just this narrow slice).
// ---------------------------------------------------------------------------

/** GET /admin/agents — all agents (active and inactive), so the UI can
 * both offer them for new assignments and correctly resolve/display the
 * name of an agent an entity is already assigned to, even if that agent
 * has since been deactivated (see the "(inactive)" suffix in the option
 * label built by each page's own loadAgentOptions()). */
export async function adminFetchAllAgentsForAssignment(password) {
  return adminRequest('/admin/agents?limit=200', { password });
}

export async function adminAssignLead(id, assignedAgentId, password) {
  return adminRequest(`/admin/leads/${encodeURIComponent(id)}/assign`, {
    method: 'PATCH',
    password,
    body: { assignedAgentId }
  });
}

export async function adminAssignVinCheck(id, assignedAgentId, password) {
  return adminRequest(`/admin/vin-checks/${encodeURIComponent(id)}/assign`, {
    method: 'PATCH',
    password,
    body: { assignedAgentId }
  });
}

/** POST /admin/vin-checks/:id/run-provider — triggers the currently
 * configured real (or mock_real) VIN provider for this check. Only
 * meaningful when the backend's VIN_PROVIDER isn't "demo" — see
 * vinProviderMode on the GET /admin/vin-checks/:id response, which the
 * admin UI uses to show/hide this action. */
export async function adminRunVinProvider(id, password) {
  return adminRequest(`/admin/vin-checks/${encodeURIComponent(id)}/run-provider`, {
    method: 'POST',
    password
  });
}

/** GET /admin/vin-checks/:id/provider-runs — full history of real/
 * mock_real provider attempts for this VIN check (not the demo result
 * itself, which lives directly on the vin_check record). */
export async function adminFetchVinProviderRuns(id, password) {
  return adminRequest(`/admin/vin-checks/${encodeURIComponent(id)}/provider-runs`, { password });
}

/** POST /admin/agents/run-business-agent — runs one of the 4 wave-2
 * business agents (crm_follow_up/b2b_sales/support/operations_payment)
 * against a single entity, creating one or more agent_tasks rows. Never
 * sends anything, never changes the entity, never deletes data — see
 * backend/README.md's "AI agents — wave 2" section. Used by the
 * "Generate follow-up" button on admin-leads.html. */
export async function adminRunBusinessAgent(agentName, entityType, entityId, password) {
  return adminRequest('/admin/agents/run-business-agent', {
    method: 'POST',
    password,
    body: { agentName, entityType, entityId }
  });
}

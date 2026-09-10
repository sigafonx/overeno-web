// Reads the backend URL from window.OVERENO_CONFIG (set by js/config.js,
// loaded before this script — see that file for the full explanation).
// Falls back to the same localhost default if config.js is missing/failed
// to load, so local dev never breaks without it.
const API_BASE_URL = (window.OVERENO_CONFIG && window.OVERENO_CONFIG.apiBaseUrl) || 'http://localhost:3001';
const ADMIN_HEADER = 'x-admin-password';
const SESSION_KEY = 'overeno_admin_password';

// This page talks directly to the /admin/bookings/* endpoints rather than
// going through js/api/api.js — those admin helpers there are scoped to
// leads (adminFetchLeads etc.) and this keeps admin-leads.html completely
// untouched. Same request/error shape as api.js's adminRequest(), just a
// local copy so nothing here can affect the leads admin page.
async function adminRequest(path, { method = 'GET', password, body } = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [ADMIN_HEADER]: password || ''
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // ignore — res.ok check below still applies
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

function adminFetchBookings(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/bookings${query ? '?' + query : ''}`, { password });
}

/** GET /admin/bookings/:id — response is { ok, item }. Used by openDetail()
 * to refresh a single booking's status/note (and paidAt/paymentId) from
 * the server every time the detail view opens. */
function adminFetchBooking(id, password) {
  return adminRequest(`/admin/bookings/${encodeURIComponent(id)}`, { password });
}

function adminUpdateBookingStatus(id, status, password) {
  return adminRequest(`/admin/bookings/${encodeURIComponent(id)}/status`, { method: 'PATCH', password, body: { status } });
}

function adminUpdateBookingNote(id, internalNote, password) {
  return adminRequest(`/admin/bookings/${encodeURIComponent(id)}/note`, { method: 'PATCH', password, body: { internalNote } });
}

function adminDeleteBooking(id, password) {
  return adminRequest(`/admin/bookings/${encodeURIComponent(id)}`, { method: 'DELETE', password });
}

async function adminExportBookingsCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  const res = await fetch(`${API_BASE_URL}/admin/bookings/export.csv${query ? '?' + query : ''}`, {
    headers: { [ADMIN_HEADER]: password || '' }
  });
  if (!res.ok) {
    let message = `Export failed with status ${res.status}.`;
    try {
      const data = await res.json();
      if (data && data.message) message = data.message;
    } catch {
      // keep the generic message
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

/** GET /admin/agents — all agents (active + inactive), same rationale as
 * admin-leads.js's api.js helper: need inactive ones too, to correctly
 * label an entity that's already assigned to someone since deactivated. */
function adminFetchAllAgentsForAssignment(password) {
  return adminRequest('/admin/agents?limit=200', { password });
}

function adminAssignBooking(id, assignedAgentId, password) {
  return adminRequest(`/admin/bookings/${encodeURIComponent(id)}/assign`, {
    method: 'PATCH',
    password,
    body: { assignedAgentId }
  });
}

/** POST /admin/agents/run-business-agent — see js/api/api.js's own copy
 * of this same call (used by admin-leads.html) for the full comment;
 * duplicated here rather than imported since this page is deliberately
 * self-contained. Never sends anything, never changes the booking,
 * never deletes data — only creates agent_tasks rows. */
function adminRunBusinessAgent(agentName, entityType, entityId, password) {
  return adminRequest('/admin/agents/run-business-agent', {
    method: 'POST',
    password,
    body: { agentName, entityType, entityId }
  });
}

/** Only endpoints this page needs from the inspector workflow — full
 * management (assign inspector, change status, checklist) happens on
 * admin-inspection-jobs.html, this page only creates the job and shows
 * a summary + link. */
function adminCreateInspectionJob(bookingId, password) {
  return adminRequest(`/admin/bookings/${encodeURIComponent(bookingId)}/inspection-job`, { method: 'POST', password });
}

function adminFetchInspectionJobForBooking(bookingId, password) {
  return adminRequest(`/admin/inspection-jobs?bookingId=${encodeURIComponent(bookingId)}`, { password });
}

// ---------------------------------------------------------------------------
// Page logic
// ---------------------------------------------------------------------------

const els = {};
let currentBookings = [];
let agentsCache = [];
let searchDebounceTimer = null;
let activeBookingId = null;

function $(id) {
  return document.getElementById(id);
}

function getPassword() {
  return els.passwordInput.value.trim();
}

function setAuthNote(text, isError) {
  els.authNote.textContent = text || '';
  els.authNote.style.color = isError ? 'var(--brick)' : '';
}

function setListStatus(text, isError) {
  els.listStatus.textContent = text || '';
  els.listStatus.classList.toggle('error', !!isError);
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value === undefined || value === null ? '' : String(value);
  return div.innerHTML;
}

async function loadAgentOptions(password) {
  try {
    const res = await adminFetchAllAgentsForAssignment(password);
    agentsCache = res.items || [];
  } catch {
    agentsCache = [];
  }
}

function agentNameFor(assignedAgentId) {
  if (!assignedAgentId) return null;
  return agentsCache.find((a) => a.id === assignedAgentId) || null;
}

function populateAgentSelect(selectEl, currentAgentId) {
  const options = ['<option value="">— Nepřiřazeno —</option>'];
  for (const agent of agentsCache) {
    const label = agent.active ? agent.name : `${agent.name} (inactive)`;
    options.push(`<option value="${escapeHtml(agent.id)}">${escapeHtml(label)}</option>`);
  }
  selectEl.innerHTML = options.join('');
  selectEl.value = currentAgentId || '';
}

async function loadBookings() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    status: els.filterStatus.value,
    city: els.filterCity.value.trim(),
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchBookings(params, password);
    currentBookings = res.items || [];
    await loadAgentOptions(password);
    renderTable(currentBookings);
    setListStatus(`Načteno ${res.items.length} z ${res.total} objednávek.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentBookings = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst objednávky: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(bookings) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = bookings.length === 0 ? 'block' : 'none';

  for (const booking of bookings) {
    const tr = document.createElement('tr');
    const contact = booking.contactName || booking.email || booking.phone || '—';
    const agent = agentNameFor(booking.assignedAgentId);
    const agentCell = agent
      ? `${escapeHtml(agent.name)}${agent.active ? '' : ' <span class="status-badge status-cancelled">inactive</span>'}`
      : '—';
    tr.innerHTML = `
      <td>${formatDate(booking.createdAt)}</td>
      <td><span class="status-badge status-${escapeHtml(booking.status)}">${escapeHtml(booking.status)}</span></td>
      <td>${booking.vin ? `<span class="type-badge">${escapeHtml(booking.vin)}</span>` : '—'}</td>
      <td>${escapeHtml(booking.city)}</td>
      <td>${escapeHtml(booking.preferredSlot)}</td>
      <td>${escapeHtml(contact)}</td>
      <td>${formatDate(booking.paidAt)}</td>
      <td>${agentCell}</td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(booking.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

const DETAIL_FIELD_LABELS = {
  id: 'ID',
  vin: 'VIN',
  listingUrl: 'Odkaz na inzerát',
  city: 'Město',
  preferredSlot: 'Preferovaný termín',
  contactName: 'Kontakt',
  email: 'E-mail',
  phone: 'Telefon',
  language: 'Jazyk',
  source: 'Zdroj',
  message: 'Zpráva',
  paidAt: 'Zaplaceno',
  paymentId: 'ID platby (viz admin-payments.html)',
  createdAt: 'Vytvořeno',
  updatedAt: 'Aktualizováno'
};

function renderDetail(booking) {
  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .filter(([key]) => booking[key] !== undefined && booking[key] !== '')
    .map(([key, label]) => `
      <div><span class="k">${escapeHtml(label)}</span><span class="v">${key.endsWith('At') ? formatDate(booking[key]) : escapeHtml(booking[key])}</span></div>
    `).join('');

  els.detailStatus.value = booking.status || 'new';
  els.detailNote.value = booking.internalNote || '';
  populateAgentSelect(els.detailAssignedAgent, booking.assignedAgentId);
}

async function openDetail(id) {
  const cachedBooking = currentBookings.find((b) => b.id === id);
  if (!cachedBooking) return;

  activeBookingId = id;
  els.detailStatusMsg.textContent = '';
  els.detailStatusMsg.classList.remove('error');
  els.detailNextStepMsg.textContent = '';
  els.detailNextStepMsg.classList.remove('error');
  els.inspectionJobMsg.textContent = '';
  els.inspectionJobMsg.classList.remove('error');

  // Render immediately from whatever the list already has, so the modal
  // isn't empty while the fresh fetch below is in flight.
  renderDetail(cachedBooking);
  refreshInspectionJobPanel(cachedBooking);
  els.detailOverlay.classList.add('open');

  // Always confirm against the server on open — not just the list's
  // cached copy — so status/note (and payment-linking fields like
  // paidAt/paymentId, which this never touches) reflect what's actually
  // saved right now.
  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchBooking(id, password);
    const fresh = res.item;
    const idx = currentBookings.findIndex((b) => b.id === id);
    if (idx !== -1) currentBookings[idx] = fresh;
    if (activeBookingId === id) {
      renderDetail(fresh); // guard: modal might have moved on already
      refreshInspectionJobPanel(fresh);
    }
  } catch (err) {
    if (activeBookingId === id) {
      els.detailStatusMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailStatusMsg.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeBookingId = null;
}

async function saveDetail() {
  if (!activeBookingId) return;
  const password = getPassword();
  const status = els.detailStatus.value;
  const note = els.detailNote.value;
  const assignedAgentId = els.detailAssignedAgent.value || null;

  els.detailSave.disabled = true;
  els.detailStatusMsg.textContent = 'Ukládám…';
  els.detailStatusMsg.classList.remove('error');

  try {
    await adminUpdateBookingStatus(activeBookingId, status, password);
    await adminUpdateBookingNote(activeBookingId, note, password);
    await adminAssignBooking(activeBookingId, assignedAgentId, password);
    els.detailStatusMsg.textContent = 'Uloženo.';
    await loadBookings();
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  } finally {
    els.detailSave.disabled = false;
  }
}

async function deleteDetail() {
  if (!activeBookingId) return;
  if (!confirm('Opravdu trvale smazat tuto objednávku?')) return;

  const password = getPassword();
  els.detailDelete.disabled = true;

  try {
    await adminDeleteBooking(activeBookingId, password);
    closeDetail();
    await loadBookings();
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se smazat: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  } finally {
    els.detailDelete.disabled = false;
  }
}

async function exportCsv() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  // Export respects whatever is currently in the filter fields, so the
  // downloaded CSV matches what's on screen.
  const params = {
    status: els.filterStatus.value,
    city: els.filterCity.value.trim(),
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportBookingsCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bookings-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setListStatus(`Export se nezdařil: ${err.message}`, true);
  }
}

async function suggestNextStep() {
  if (!activeBookingId) return;
  const password = getPassword();
  if (!password) {
    els.detailNextStepMsg.textContent = 'Zadejte admin heslo.';
    els.detailNextStepMsg.classList.add('error');
    return;
  }

  els.detailSuggestNextStepBtn.disabled = true;
  els.detailNextStepMsg.textContent = 'Generuji návrh (mock provider)…';
  els.detailNextStepMsg.classList.remove('error');

  try {
    const res = await adminRunBusinessAgent('crm_follow_up', 'booking', activeBookingId, password);
    const link = `admin-agent-tasks.html?entityType=booking&entityId=${encodeURIComponent(activeBookingId)}`;
    els.detailNextStepMsg.innerHTML = `Vytvořeno ${res.tasks.length} task(ů). <a href="${link}" target="_blank" rel="noopener">Otevřít v Agent tasks ↗</a>`;
  } catch (err) {
    els.detailNextStepMsg.textContent = `Nepodařilo se vygenerovat návrh: ${err.message}`;
    els.detailNextStepMsg.classList.add('error');
  } finally {
    els.detailSuggestNextStepBtn.disabled = false;
  }
}

function renderInspectionJobPanel(booking, job) {
  if (job) {
    els.inspectionJobNoJob.style.display = 'none';
    els.inspectionJobExists.style.display = 'block';
    els.inspectionJobIdText.textContent = job.id;
    els.inspectionJobStatusBadge.textContent = job.status;
    els.inspectionJobStatusBadge.className = `status-badge status-${job.status === 'completed' || job.status === 'checklist_done' ? 'completed' : job.status === 'cancelled' ? 'dismissed' : 'open'}`;
    els.inspectionJobLink.href = `admin-inspection-jobs.html?jobId=${encodeURIComponent(job.id)}`;
  } else {
    els.inspectionJobExists.style.display = 'none';
    els.inspectionJobNoJob.style.display = 'block';
    const canCreate = booking.status === 'paid';
    els.createInspectionJobBtn.disabled = !canCreate;
    els.inspectionJobHint.textContent = canCreate
      ? 'Objednávka je zaplacená — lze vytvořit inspection job.'
      : 'Dostupné jen pro zaplacenou objednávku (status "paid").';
  }
}

async function refreshInspectionJobPanel(booking) {
  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchInspectionJobForBooking(booking.id, password);
    const job = (res.items || [])[0] || null;
    if (activeBookingId === booking.id) renderInspectionJobPanel(booking, job);
  } catch {
    // If this lookup fails, default to showing the create option (safe
    // default — worst case the admin sees a redundant "already exists"
    // error from the backend's own idempotency check on click).
    if (activeBookingId === booking.id) renderInspectionJobPanel(booking, null);
  }
}

async function createInspectionJobHandler() {
  if (!activeBookingId) return;
  const password = getPassword();
  if (!password) {
    els.inspectionJobMsg.textContent = 'Zadejte admin heslo.';
    els.inspectionJobMsg.classList.add('error');
    return;
  }

  els.createInspectionJobBtn.disabled = true;
  els.inspectionJobMsg.textContent = 'Vytvářím…';
  els.inspectionJobMsg.classList.remove('error');

  try {
    const res = await adminCreateInspectionJob(activeBookingId, password);
    els.inspectionJobMsg.textContent = 'Vytvořeno.';
    const booking = currentBookings.find((b) => b.id === activeBookingId);
    renderInspectionJobPanel(booking, res.job);
    // Booking status just advanced (paid -> inspector_needed) server-side —
    // refresh the detail so the status dropdown reflects it.
    try {
      const fresh = await adminFetchBooking(activeBookingId, password);
      const idx = currentBookings.findIndex((b) => b.id === activeBookingId);
      if (idx !== -1) currentBookings[idx] = fresh.item;
      if (activeBookingId === fresh.item.id) renderDetail(fresh.item);
    } catch {
      // non-fatal — the job was created either way
    }
  } catch (err) {
    els.inspectionJobMsg.textContent = `Nepodařilo se vytvořit: ${err.message}`;
    els.inspectionJobMsg.classList.add('error');
  } finally {
    els.createInspectionJobBtn.disabled = false;
  }
}

function init() {
  els.passwordInput = $('adminPasswordInput');
  els.loadBtn = $('loadBtn');
  els.authNote = $('authNote');
  els.filterStatus = $('filterStatus');
  els.filterCity = $('filterCity');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('bookingsTbody');
  els.emptyState = $('emptyState');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailFields = $('detailFields');
  els.detailStatus = $('detailStatus');
  els.detailNote = $('detailNote');
  els.detailAssignedAgent = $('detailAssignedAgent');
  els.detailStatusMsg = $('detailStatusMsg');
  els.detailSave = $('detailSave');
  els.detailDelete = $('detailDelete');
  els.detailSuggestNextStepBtn = $('detailSuggestNextStepBtn');
  els.detailNextStepMsg = $('detailNextStepMsg');
  els.inspectionJobNoJob = $('inspectionJobNoJob');
  els.inspectionJobExists = $('inspectionJobExists');
  els.createInspectionJobBtn = $('createInspectionJobBtn');
  els.inspectionJobHint = $('inspectionJobHint');
  els.inspectionJobIdText = $('inspectionJobIdText');
  els.inspectionJobStatusBadge = $('inspectionJobStatusBadge');
  els.inspectionJobLink = $('inspectionJobLink');
  els.inspectionJobMsg = $('inspectionJobMsg');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadBookings);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadBookings();
  });

  els.refreshBtn.addEventListener('click', loadBookings);
  els.filterStatus.addEventListener('change', loadBookings);
  els.filterCity.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadBookings, 350);
  });
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadBookings, 350);
  });

  els.exportBtn.addEventListener('click', exportCsv);

  els.detailClose.addEventListener('click', closeDetail);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });
  els.detailSave.addEventListener('click', saveDetail);
  els.detailDelete.addEventListener('click', deleteDetail);
  els.detailSuggestNextStepBtn.addEventListener('click', suggestNextStep);
  els.createInspectionJobBtn.addEventListener('click', createInspectionJobHandler);

  if (savedPassword) {
    loadBookings();
  }
}

document.addEventListener('DOMContentLoaded', init);

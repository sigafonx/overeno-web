// Fully self-contained, like admin-bookings.js / admin-email-logs.js — does
// not import anything from js/api/api.js, so nothing here can ever affect
// submitLead()/createBooking()/checkVin() or the other admin pages.

// Reads the backend URL from window.OVERENO_CONFIG (set by js/config.js,
// loaded before this script). Falls back to the same localhost default
// if config.js is missing/failed to load.
const API_BASE_URL = (window.OVERENO_CONFIG && window.OVERENO_CONFIG.apiBaseUrl) || 'http://localhost:3001';
const ADMIN_HEADER = 'x-admin-password';
const SESSION_KEY = 'overeno_admin_password';

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

function adminFetchPayments(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/payments${query ? '?' + query : ''}`, { password });
}

/** GET /admin/payments/:id — response is { ok, item }. Used by openDetail()
 * to refresh a single payment's internalNote from the server every time
 * the detail view opens, per this step's requirement. */
function adminFetchPayment(id, password) {
  return adminRequest(`/admin/payments/${encodeURIComponent(id)}`, { password });
}

function adminExportPaymentsCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/payments/export.csv${query ? '?' + query : ''}`, {
    headers: { [ADMIN_HEADER]: password || '' }
  }).then(async (res) => {
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
  });
}

/** PATCH /admin/payments/:id/note — response is { ok, payment } (matches
 * this endpoint's own spec, same naming style as /payments/checkout). */
function adminUpdatePaymentNote(id, internalNote, password) {
  return adminRequest(`/admin/payments/${encodeURIComponent(id)}/note`, {
    method: 'PATCH',
    password,
    body: { internalNote }
  });
}

/** POST /admin/agents/run-business-agent — see js/api/api.js's own copy
 * of this same call (used by admin-leads.html) for the full comment;
 * duplicated here since this page is deliberately self-contained. Never
 * sends anything, never changes the payment's status, never deletes
 * data — only creates agent_tasks rows. */
function adminRunBusinessAgent(agentName, entityType, entityId, password) {
  return adminRequest('/admin/agents/run-business-agent', {
    method: 'POST',
    password,
    body: { agentName, entityType, entityId }
  });
}

function adminFetchAllAgentsForAssignment(password) {
  return adminRequest('/admin/agents?limit=200', { password });
}

function adminAssignPayment(id, assignedAgentId, password) {
  return adminRequest(`/admin/payments/${encodeURIComponent(id)}/assign`, {
    method: 'PATCH',
    password,
    body: { assignedAgentId }
  });
}

// ---------------------------------------------------------------------------
// Page logic
// ---------------------------------------------------------------------------

const els = {};
let currentPayments = [];
let agentsCache = [];
let searchDebounceTimer = null;

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

/** Every field on this page goes through this so a missing entityId/
 * customerEmail/providerPaymentId/etc. never breaks rendering. */
function field(value) {
  return value === undefined || value === null || value === '' ? '—' : value;
}

/** amount is stored in minor units (see backend/payments/products.js) — for
 * CZK that's 1/100, so 49900 -> "499,00 Kč" (matching the "Kč" convention
 * already used in Pricing.js, rather than the raw ISO code). */
function formatAmount(amount, currency) {
  if (amount === undefined || amount === null) return '—';
  const major = (amount / 100).toFixed(2).replace('.', ',');
  const symbol = currency === 'CZK' ? 'Kč' : field(currency);
  return `${major} ${symbol}`;
}

async function loadPayments() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    status: els.filterStatus.value,
    productCode: els.filterProductCode.value,
    entityType: els.filterEntityType.value,
    entityId: els.filterEntityId.value.trim(),
    customerEmail: els.filterCustomerEmail.value.trim(),
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchPayments(params, password);
    currentPayments = res.items || [];
    await loadAgentOptions(password);
    renderTable(currentPayments);
    setListStatus(`Načteno ${res.items.length} z ${res.total} plateb.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentPayments = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst platby: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(payments) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = payments.length === 0 ? 'block' : 'none';

  for (const payment of payments) {
    const tr = document.createElement('tr');
    const customer = payment.customerName || payment.customerEmail || '—';
    const agent = agentNameFor(payment.assignedAgentId);
    const agentCell = agent
      ? `${escapeHtml(agent.name)}${agent.active ? '' : ' <span class="status-badge status-cancelled">inactive</span>'}`
      : '—';
    tr.innerHTML = `
      <td>${formatDate(payment.createdAt)}</td>
      <td><span class="type-badge">${escapeHtml(field(payment.id))}</span></td>
      <td>${escapeHtml(field(payment.productCode))}</td>
      <td>${escapeHtml(field(payment.entityType))}</td>
      <td>${escapeHtml(formatAmount(payment.amount, payment.currency))}</td>
      <td>${escapeHtml(field(payment.provider))}</td>
      <td>${escapeHtml(customer)}</td>
      <td><span class="status-badge status-${escapeHtml(payment.status)}">${escapeHtml(payment.status)}</span></td>
      <td>${agentCell}</td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(payment.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

const DETAIL_FIELD_LABELS = {
  id: 'ID',
  createdAt: 'Vytvořeno',
  updatedAt: 'Aktualizováno',
  productCode: 'Produkt',
  entityType: 'Typ entity',
  entityId: 'ID entity',
  status: 'Stav',
  amountFormatted: 'Částka',
  provider: 'Provider',
  providerSessionId: 'Provider session ID',
  providerPaymentId: 'Provider payment ID',
  customerEmail: 'E-mail zákazníka',
  customerName: 'Jméno zákazníka',
  paidAt: 'Zaplaceno',
  cancelledAt: 'Zrušeno',
  expiredAt: 'Vypršelo',
  failedAt: 'Selhalo'
};

let activeRecordId = null;

function renderDetail(payment) {
  const flat = { ...payment, amountFormatted: formatAmount(payment.amount, payment.currency) };

  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .map(([key, label]) => {
      let value = flat[key];
      if (key === 'createdAt' || key === 'updatedAt' || key === 'paidAt' || key === 'cancelledAt' || key === 'expiredAt' || key === 'failedAt') {
        value = value ? formatDate(value) : value;
      }
      return `<div><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(field(value))}</span></div>`;
    })
    .join('');

  // Simple text hint pointing at the admin page that owns the linked
  // entity — deliberately not a clickable deep-link (that would need to
  // pre-fill that page's filters, which isn't worth the risk right now).
  const entityPages = { booking: 'admin-bookings.html', vin_check: 'admin-vin-checks.html' };
  const targetPage = entityPages[payment.entityType];
  if (targetPage && payment.entityId) {
    els.detailEntityLinkWrap.innerHTML = `Související záznam najdete v <strong>${escapeHtml(targetPage)}</strong> — hledejte podle ID <code>${escapeHtml(payment.entityId)}</code>.`;
    els.detailEntityLinkWrap.style.display = 'block';
  } else {
    els.detailEntityLinkWrap.style.display = 'none';
  }

  if (payment.errorMessage) {
    els.detailErrorWrap.style.display = 'block';
    els.detailErrorMessage.textContent = payment.errorMessage;
  } else {
    els.detailErrorWrap.style.display = 'none';
    els.detailErrorMessage.textContent = '';
  }

  els.detailNote.value = payment.internalNote || '';
  populateAgentSelect(els.detailAssignedAgent, payment.assignedAgentId);
}

async function openDetail(id) {
  const cachedPayment = currentPayments.find((p) => p.id === id);
  if (!cachedPayment) return;

  activeRecordId = id;
  els.detailNoteStatus.textContent = '';
  els.detailNoteStatus.classList.remove('error');
  els.detailAnalyzeMsg.textContent = '';
  els.detailAnalyzeMsg.classList.remove('error');

  // Render immediately from whatever the list already has, so the modal
  // isn't empty while the fresh fetch below is in flight.
  renderDetail(cachedPayment);
  els.detailOverlay.classList.add('open');

  // Per this step's requirement, the note must always reflect the server
  // on open — not just whatever the list happened to have cached (e.g.
  // right after a save elsewhere) — so re-fetch this one payment fresh.
  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchPayment(id, password);
    const fresh = res.item;
    const idx = currentPayments.findIndex((p) => p.id === id);
    if (idx !== -1) currentPayments[idx] = fresh;
    if (activeRecordId === id) renderDetail(fresh); // guard: modal might have moved on already
  } catch (err) {
    if (activeRecordId === id) {
      els.detailNoteStatus.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailNoteStatus.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeRecordId = null;
}

async function saveNote() {
  if (!activeRecordId) return;
  const password = getPassword();
  if (!password) {
    els.detailNoteStatus.textContent = 'Zadejte admin heslo.';
    els.detailNoteStatus.classList.add('error');
    return;
  }

  const internalNote = els.detailNote.value;
  const assignedAgentId = els.detailAssignedAgent.value || null;

  els.detailNoteSave.disabled = true;
  els.detailNoteStatus.textContent = 'Ukládám…';
  els.detailNoteStatus.classList.remove('error');

  try {
    const res = await adminUpdatePaymentNote(activeRecordId, internalNote, password);
    await adminAssignPayment(activeRecordId, assignedAgentId, password);
    const updated = res.payment;

    const idx = currentPayments.findIndex((p) => p.id === activeRecordId);
    if (idx !== -1) currentPayments[idx] = { ...currentPayments[idx], internalNote: updated.internalNote, updatedAt: updated.updatedAt, assignedAgentId };
    renderTable(currentPayments);

    els.detailNoteStatus.textContent = 'Uloženo.';
  } catch (err) {
    if (err.status === 401) {
      els.detailNoteStatus.textContent = 'Neplatné admin heslo.';
    } else if (err.status === 404) {
      els.detailNoteStatus.textContent = 'Platba už neexistuje.';
    } else {
      els.detailNoteStatus.textContent = `Nepodařilo se uložit: ${err.message}`;
    }
    els.detailNoteStatus.classList.add('error');
  } finally {
    els.detailNoteSave.disabled = false;
  }
}

async function exportCsv() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  const params = {
    status: els.filterStatus.value,
    productCode: els.filterProductCode.value,
    entityType: els.filterEntityType.value,
    entityId: els.filterEntityId.value.trim(),
    customerEmail: els.filterCustomerEmail.value.trim(),
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportPaymentsCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    if (err.status === 401) {
      setListStatus('Neplatné admin heslo.', true);
    } else {
      setListStatus(`Export se nezdařil: ${err.message}`, true);
    }
  }
}

async function analyzePaymentIssue() {
  if (!activeRecordId) return;
  const password = getPassword();
  if (!password) {
    els.detailAnalyzeMsg.textContent = 'Zadejte admin heslo.';
    els.detailAnalyzeMsg.classList.add('error');
    return;
  }

  els.detailAnalyzePaymentBtn.disabled = true;
  els.detailAnalyzeMsg.textContent = 'Generuji návrh (mock provider)…';
  els.detailAnalyzeMsg.classList.remove('error');

  try {
    const res = await adminRunBusinessAgent('operations_payment', 'payment', activeRecordId, password);
    const link = `admin-agent-tasks.html?entityType=payment&entityId=${encodeURIComponent(activeRecordId)}`;
    els.detailAnalyzeMsg.innerHTML = `Vytvořeno ${res.tasks.length} task(ů). <a href="${link}" target="_blank" rel="noopener">Otevřít v Agent tasks ↗</a>`;
  } catch (err) {
    els.detailAnalyzeMsg.textContent = `Nepodařilo se vygenerovat návrh: ${err.message}`;
    els.detailAnalyzeMsg.classList.add('error');
  } finally {
    els.detailAnalyzePaymentBtn.disabled = false;
  }
}

function init() {
  els.passwordInput = $('adminPasswordInput');
  els.loadBtn = $('loadBtn');
  els.authNote = $('authNote');
  els.filterStatus = $('filterStatus');
  els.filterProductCode = $('filterProductCode');
  els.filterEntityType = $('filterEntityType');
  els.filterEntityId = $('filterEntityId');
  els.filterCustomerEmail = $('filterCustomerEmail');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('paymentsTbody');
  els.emptyState = $('emptyState');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailFields = $('detailFields');
  els.detailEntityLinkWrap = $('detailEntityLinkWrap');
  els.detailErrorWrap = $('detailErrorWrap');
  els.detailErrorMessage = $('detailErrorMessage');
  els.detailNote = $('detailNote');
  els.detailAssignedAgent = $('detailAssignedAgent');
  els.detailNoteStatus = $('detailNoteStatus');
  els.detailNoteSave = $('detailNoteSave');
  els.detailAnalyzePaymentBtn = $('detailAnalyzePaymentBtn');
  els.detailAnalyzeMsg = $('detailAnalyzeMsg');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadPayments);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadPayments();
  });

  els.refreshBtn.addEventListener('click', loadPayments);
  els.exportBtn.addEventListener('click', exportCsv);

  els.filterStatus.addEventListener('change', loadPayments);
  els.filterProductCode.addEventListener('change', loadPayments);
  els.filterEntityType.addEventListener('change', loadPayments);
  [els.filterEntityId, els.filterCustomerEmail, els.filterSearch].forEach((input) => {
    input.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(loadPayments, 350);
    });
  });

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailNoteSave.addEventListener('click', saveNote);
  els.detailAnalyzePaymentBtn.addEventListener('click', analyzePaymentIssue);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadPayments();
  }
}

document.addEventListener('DOMContentLoaded', init);

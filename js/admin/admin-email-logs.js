// Fully self-contained, like admin-bookings.js — does not import anything
// from js/api/api.js, so nothing here can ever affect submitLead()/
// createBooking()/checkVin() or the other admin pages.

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

function adminFetchEmailLogs(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/email-logs${query ? '?' + query : ''}`, { password });
}

/** GET /admin/email-logs/:id — response is { ok, item }. Used by
 * openDetail() to refresh a single log's review state from the server
 * every time the detail view opens, matching the other four admin pages. */
function adminFetchEmailLog(id, password) {
  return adminRequest(`/admin/email-logs/${encodeURIComponent(id)}`, { password });
}

function adminExportEmailLogsCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/email-logs/export.csv${query ? '?' + query : ''}`, {
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

/** PATCH /admin/email-logs/:id/review — payload may include any of
 * { reviewed, resolved, internalNote }; response is { ok, emailLog }. */
function adminUpdateEmailLogReview(id, payload, password) {
  return adminRequest(`/admin/email-logs/${encodeURIComponent(id)}/review`, {
    method: 'PATCH',
    password,
    body: payload
  });
}

// ---------------------------------------------------------------------------
// Page logic
// ---------------------------------------------------------------------------

const els = {};
let currentLogs = [];
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

/** Every field on this page goes through this so a missing recipientEmail/
 * subject/errorMessage never breaks rendering — it just shows "—". */
function field(value) {
  return value === undefined || value === null || value === '' ? '—' : value;
}

async function loadEmailLogs() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    entityType: els.filterEntityType.value,
    status: els.filterStatus.value,
    reviewed: els.filterReviewed.value,
    resolved: els.filterResolved.value,
    entityId: els.filterEntityId.value.trim(),
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchEmailLogs(params, password);
    currentLogs = res.items || [];
    renderTable(currentLogs);
    setListStatus(`Načteno ${res.items.length} z ${res.total} email logů.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentLogs = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst email logy: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function renderTable(logs) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = logs.length === 0 ? 'block' : 'none';

  for (const log of logs) {
    const tr = document.createElement('tr');
    const errorPreview = log.errorMessage
      ? `<span class="error-message-preview" title="${escapeHtml(log.errorMessage)}">${escapeHtml(truncate(log.errorMessage, 40))}</span>`
      : '—';
    const reviewBadges = [
      log.reviewedAt ? '<span class="status-badge status-paid">Reviewed</span>' : '',
      log.resolvedAt ? '<span class="status-badge status-paid">Resolved</span>' : ''
    ].filter(Boolean).join(' ') || '—';
    tr.innerHTML = `
      <td>${formatDate(log.createdAt)}</td>
      <td><span class="type-badge">${escapeHtml(field(log.id))}</span></td>
      <td>${escapeHtml(field(log.entityType))}</td>
      <td>${escapeHtml(field(log.entityId))}</td>
      <td>${escapeHtml(field(log.recipientType))}</td>
      <td>${escapeHtml(field(log.recipientEmail))}</td>
      <td>${escapeHtml(field(log.subject))}</td>
      <td><span class="status-badge status-${escapeHtml(log.status)}">${escapeHtml(log.status)}</span></td>
      <td>${errorPreview}</td>
      <td>${reviewBadges}</td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(log.id)}">Detail</button></td>
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
  entityType: 'Typ entity',
  entityId: 'ID entity',
  recipientType: 'Typ příjemce',
  recipientEmail: 'E-mail příjemce',
  subject: 'Předmět',
  status: 'Stav'
};

let activeLogId = null;

function renderDetail(log) {
  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .map(([key, label]) => {
      const value = key === 'createdAt' ? formatDate(log[key]) : log[key];
      return `<div><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(field(value))}</span></div>`;
    })
    .join('');

  if (log.errorMessage) {
    els.detailErrorWrap.style.display = 'block';
    els.detailErrorMessage.textContent = log.errorMessage;
  } else {
    els.detailErrorWrap.style.display = 'none';
    els.detailErrorMessage.textContent = '';
  }

  els.detailReviewed.checked = !!log.reviewedAt;
  els.detailResolved.checked = !!log.resolvedAt;
  els.detailReviewNote.value = log.internalNote || '';
}

async function openDetail(id) {
  const cachedLog = currentLogs.find((l) => l.id === id);
  if (!cachedLog) return;

  activeLogId = id;
  els.detailReviewStatus.textContent = '';
  els.detailReviewStatus.classList.remove('error');

  // Render immediately from whatever the list already has, so the modal
  // isn't empty while the fresh fetch below is in flight.
  renderDetail(cachedLog);
  els.detailOverlay.classList.add('open');

  // Always confirm against the server on open — not just the list's
  // cached copy — so reviewed/resolved/internalNote reflect what's
  // actually saved right now (matches the other four admin pages).
  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchEmailLog(id, password);
    const fresh = res.item;
    const idx = currentLogs.findIndex((l) => l.id === id);
    if (idx !== -1) currentLogs[idx] = fresh;
    if (activeLogId === id) renderDetail(fresh); // guard: modal might have moved on already
  } catch (err) {
    if (activeLogId === id) {
      els.detailReviewStatus.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailReviewStatus.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeLogId = null;
}

async function saveReview() {
  if (!activeLogId) return;
  const password = getPassword();
  if (!password) {
    els.detailReviewStatus.textContent = 'Zadejte admin heslo.';
    els.detailReviewStatus.classList.add('error');
    return;
  }

  const payload = {
    reviewed: els.detailReviewed.checked,
    resolved: els.detailResolved.checked,
    internalNote: els.detailReviewNote.value
  };

  els.detailReviewSave.disabled = true;
  els.detailReviewStatus.textContent = 'Ukládám…';
  els.detailReviewStatus.classList.remove('error');

  try {
    const res = await adminUpdateEmailLogReview(activeLogId, payload, password);
    const updated = res.emailLog;

    // Keep the in-memory list in sync so re-opening this row (or looking at
    // the table's badges) without a full reload reflects what was just saved.
    const idx = currentLogs.findIndex((l) => l.id === activeLogId);
    if (idx !== -1) {
      currentLogs[idx] = { ...currentLogs[idx], reviewedAt: updated.reviewedAt, resolvedAt: updated.resolvedAt, internalNote: updated.internalNote };
      renderTable(currentLogs);
    }

    els.detailReviewStatus.textContent = 'Uloženo.';
  } catch (err) {
    if (err.status === 401) {
      els.detailReviewStatus.textContent = 'Neplatné admin heslo.';
    } else if (err.status === 404) {
      els.detailReviewStatus.textContent = 'Email log už neexistuje.';
    } else {
      els.detailReviewStatus.textContent = `Nepodařilo se uložit: ${err.message}`;
    }
    els.detailReviewStatus.classList.add('error');
  } finally {
    els.detailReviewSave.disabled = false;
  }
}

async function exportCsv() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  // Export respects whatever is currently in the filter fields, so the
  // downloaded CSV matches what's on screen (e.g. only "failed" rows).
  const params = {
    entityType: els.filterEntityType.value,
    status: els.filterStatus.value,
    reviewed: els.filterReviewed.value,
    resolved: els.filterResolved.value,
    entityId: els.filterEntityId.value.trim(),
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportEmailLogsCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `email-logs-${new Date().toISOString().slice(0, 10)}.csv`;
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

function init() {
  els.passwordInput = $('adminPasswordInput');
  els.loadBtn = $('loadBtn');
  els.authNote = $('authNote');
  els.filterEntityType = $('filterEntityType');
  els.filterStatus = $('filterStatus');
  els.filterReviewed = $('filterReviewed');
  els.filterResolved = $('filterResolved');
  els.filterEntityId = $('filterEntityId');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('emailLogsTbody');
  els.emptyState = $('emptyState');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailFields = $('detailFields');
  els.detailErrorWrap = $('detailErrorWrap');
  els.detailErrorMessage = $('detailErrorMessage');
  els.detailReviewed = $('detailReviewed');
  els.detailResolved = $('detailResolved');
  els.detailReviewNote = $('detailReviewNote');
  els.detailReviewStatus = $('detailReviewStatus');
  els.detailReviewSave = $('detailReviewSave');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadEmailLogs);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadEmailLogs();
  });

  els.refreshBtn.addEventListener('click', loadEmailLogs);
  els.exportBtn.addEventListener('click', exportCsv);
  els.filterEntityType.addEventListener('change', loadEmailLogs);
  els.filterStatus.addEventListener('change', loadEmailLogs);
  els.filterReviewed.addEventListener('change', loadEmailLogs);
  els.filterResolved.addEventListener('change', loadEmailLogs);
  els.filterEntityId.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadEmailLogs, 350);
  });
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadEmailLogs, 350);
  });

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailReviewSave.addEventListener('click', saveReview);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadEmailLogs();
  }
}

document.addEventListener('DOMContentLoaded', init);

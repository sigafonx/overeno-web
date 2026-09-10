// Fully self-contained, like admin-bookings.js/admin-payments.js/
// admin-agents.js/admin-reports.js — does not import anything from
// js/api/api.js, so nothing here can ever affect the other admin pages
// or public forms.

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

function adminFetchAiRuns(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/ai/runs${query ? '?' + query : ''}`, { password });
}

function adminFetchAiRun(id, password) {
  return adminRequest(`/admin/ai/runs/${encodeURIComponent(id)}`, { password });
}

function adminReviewAiRun(id, payload, password) {
  return adminRequest(`/admin/ai/runs/${encodeURIComponent(id)}/review`, { method: 'PATCH', password, body: payload });
}

function adminExportAiRunsCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/ai/runs/export.csv${query ? '?' + query : ''}`, {
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

// ---------------------------------------------------------------------------
// Page logic
// ---------------------------------------------------------------------------

const els = {};
let currentRuns = [];
let activeRunId = null;
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

function field(value) {
  return value === undefined || value === null || value === '' ? '—' : value;
}

function reviewState(run) {
  if (run.approvedAt) return 'approved';
  if (run.rejectedAt) return 'rejected';
  return 'pending';
}

const DETAIL_FIELD_LABELS = {
  id: 'ID',
  createdAt: 'Vytvořeno',
  updatedAt: 'Aktualizováno',
  agentName: 'Agent',
  entityType: 'Typ entity',
  entityId: 'ID entity',
  status: 'Stav',
  provider: 'Provider',
  model: 'Model',
  estimatedCost: 'Odhad nákladu',
  requiresHumanReview: 'Vyžaduje review',
  reviewedAt: 'Review provedeno',
  approvedAt: 'Schváleno',
  rejectedAt: 'Zamítnuto'
};

async function loadRuns() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    agentName: els.filterAgentName.value,
    status: els.filterStatus.value,
    entityType: els.filterEntityType.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchAiRuns(params, password);
    currentRuns = res.items || [];
    renderTable(currentRuns);
    setListStatus(`Načteno ${res.items.length} z ${res.total} AI runs.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentRuns = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst AI runs: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(runs) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = runs.length === 0 ? 'block' : 'none';

  for (const run of runs) {
    const tr = document.createElement('tr');
    const rs = reviewState(run);
    tr.innerHTML = `
      <td>${formatDate(run.createdAt)}</td>
      <td><span class="type-badge">${escapeHtml(field(run.agentName))}</span></td>
      <td>${escapeHtml(field(run.entityType))} <code>${escapeHtml(field(run.entityId))}</code></td>
      <td><span class="status-badge status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td><span class="status-badge status-${rs}">${rs}</span></td>
      <td>${escapeHtml(field(run.estimatedCost))}</td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(run.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

function prettyJson(jsonString) {
  if (!jsonString) return '(prázdné)';
  try {
    return JSON.stringify(JSON.parse(jsonString), null, 2);
  } catch {
    return jsonString;
  }
}

function renderDetail(run) {
  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .filter(([key]) => run[key] !== undefined && run[key] !== '' && run[key] !== null)
    .map(([key, label]) => {
      let value = run[key];
      if (key.endsWith('At')) value = formatDate(value);
      if (key === 'requiresHumanReview') value = value ? 'ano' : 'ne';
      return `<div><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></div>`;
    }).join('');

  els.detailInput.textContent = prettyJson(run.inputJson);
  els.detailOutput.textContent = prettyJson(run.outputJson);

  if (run.errorMessage) {
    els.detailErrorWrap.style.display = 'block';
    els.detailErrorMessage.textContent = run.errorMessage;
  } else {
    els.detailErrorWrap.style.display = 'none';
  }

  els.detailReviewNote.value = run.reviewNote || '';
  const rs = reviewState(run);
  els.detailApproveBtn.disabled = rs === 'approved';
  els.detailRejectBtn.disabled = rs === 'rejected';
}

async function openDetail(id) {
  const cachedRun = currentRuns.find((r) => r.id === id);
  if (!cachedRun) return;

  activeRunId = id;
  els.detailReviewMsg.textContent = '';
  els.detailReviewMsg.classList.remove('error');

  renderDetail(cachedRun);
  els.detailOverlay.classList.add('open');

  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchAiRun(id, password);
    const idx = currentRuns.findIndex((r) => r.id === id);
    if (idx !== -1) currentRuns[idx] = res.item;
    if (activeRunId === id) renderDetail(res.item);
  } catch (err) {
    if (activeRunId === id) {
      els.detailReviewMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailReviewMsg.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeRunId = null;
}

async function submitReview(approved) {
  if (!activeRunId) return;
  const password = getPassword();
  if (!password) {
    els.detailReviewMsg.textContent = 'Zadejte admin heslo.';
    els.detailReviewMsg.classList.add('error');
    return;
  }

  els.detailApproveBtn.disabled = true;
  els.detailRejectBtn.disabled = true;
  els.detailReviewMsg.textContent = 'Ukládám…';
  els.detailReviewMsg.classList.remove('error');

  try {
    const res = await adminReviewAiRun(activeRunId, { approved, reviewNote: els.detailReviewNote.value }, password);
    const idx = currentRuns.findIndex((r) => r.id === activeRunId);
    if (idx !== -1) {
      currentRuns[idx] = res.run;
      renderTable(currentRuns);
    }
    renderDetail(res.run);
    els.detailReviewMsg.textContent = approved ? 'Schváleno.' : 'Zamítnuto.';
  } catch (err) {
    els.detailReviewMsg.textContent = `Nepodařilo se uložit review: ${err.message}`;
    els.detailReviewMsg.classList.add('error');
    const rs = reviewState(currentRuns.find((r) => r.id === activeRunId) || {});
    els.detailApproveBtn.disabled = rs === 'approved';
    els.detailRejectBtn.disabled = rs === 'rejected';
  }
}

async function exportCsv() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  const params = {
    agentName: els.filterAgentName.value,
    status: els.filterStatus.value,
    entityType: els.filterEntityType.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportAiRunsCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setListStatus(`Export se nezdařil: ${err.message}`, true);
  }
}

function init() {
  els.passwordInput = $('adminPasswordInput');
  els.loadBtn = $('loadBtn');
  els.authNote = $('authNote');
  els.filterAgentName = $('filterAgentName');
  els.filterStatus = $('filterStatus');
  els.filterEntityType = $('filterEntityType');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('aiRunsTbody');
  els.emptyState = $('emptyState');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailFields = $('detailFields');
  els.detailInput = $('detailInput');
  els.detailOutput = $('detailOutput');
  els.detailErrorWrap = $('detailErrorWrap');
  els.detailErrorMessage = $('detailErrorMessage');
  els.detailReviewNote = $('detailReviewNote');
  els.detailApproveBtn = $('detailApproveBtn');
  els.detailRejectBtn = $('detailRejectBtn');
  els.detailReviewMsg = $('detailReviewMsg');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  // Pre-fill filters when arriving from admin-reports.html's "Run AI
  // helper" link (?entityType=report&entityId=report_xxx) — purely a
  // convenience, does not change what data is fetched beyond what the
  // filter dropdowns/search box already support.
  const urlParams = new URLSearchParams(window.location.search);
  const presetEntityType = urlParams.get('entityType');
  const presetEntityId = urlParams.get('entityId');
  if (presetEntityType && Array.from(els.filterEntityType.options).some((o) => o.value === presetEntityType)) {
    els.filterEntityType.value = presetEntityType;
  }
  if (presetEntityId) {
    els.filterSearch.value = presetEntityId;
  }

  els.loadBtn.addEventListener('click', loadRuns);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadRuns();
  });

  els.refreshBtn.addEventListener('click', loadRuns);
  els.exportBtn.addEventListener('click', exportCsv);
  els.filterAgentName.addEventListener('change', loadRuns);
  els.filterStatus.addEventListener('change', loadRuns);
  els.filterEntityType.addEventListener('change', loadRuns);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadRuns, 350);
  });

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailApproveBtn.addEventListener('click', () => submitReview(true));
  els.detailRejectBtn.addEventListener('click', () => submitReview(false));
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadRuns();
  }
}

document.addEventListener('DOMContentLoaded', init);

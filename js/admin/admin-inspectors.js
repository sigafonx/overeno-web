// Fully self-contained, like admin-ai-runs.js/admin-agent-tasks.js —
// does not import anything from js/api/api.js.

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

function adminFetchInspectors(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/inspectors${query ? '?' + query : ''}`, { password });
}

function adminCreateInspector(payload, password) {
  return adminRequest('/admin/inspectors', { method: 'POST', password, body: payload });
}

function adminUpdateInspector(id, payload, password) {
  return adminRequest(`/admin/inspectors/${encodeURIComponent(id)}`, { method: 'PATCH', password, body: payload });
}

function adminExportInspectorsCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/inspectors/export.csv${query ? '?' + query : ''}`, {
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
let currentInspectors = [];
let activeInspectorId = null; // null = create mode
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

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value === undefined || value === null ? '' : String(value);
  return div.innerHTML;
}

function field(value) {
  return value === undefined || value === null || value === '' ? '—' : value;
}

async function loadInspectors() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    active: els.filterActive.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchInspectors(params, password);
    currentInspectors = res.items || [];
    renderTable(currentInspectors);
    setListStatus(`Načteno ${res.items.length} z ${res.total} techniků.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentInspectors = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst techniky: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(inspectors) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = inspectors.length === 0 ? 'block' : 'none';

  for (const inspector of inspectors) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(inspector.name)}</td>
      <td>${escapeHtml(field(inspector.email))}<br><span style="color:var(--text-muted-dark);font-size:0.8rem;">${escapeHtml(field(inspector.phone))}</span></td>
      <td>${escapeHtml(field(inspector.city))}</td>
      <td>${escapeHtml(field(inspector.qualification))}</td>
      <td><span class="status-badge status-${inspector.active ? 'completed' : 'dismissed'}">${inspector.active ? 'aktivní' : 'neaktivní'}</span></td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(inspector.id)}">Upravit</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openEdit(btn.getAttribute('data-id')));
  });
}

function resetForm() {
  els.detailName.value = '';
  els.detailEmail.value = '';
  els.detailPhone.value = '';
  els.detailCity.value = '';
  els.detailQualification.value = '';
  els.detailInternalNote.value = '';
  els.detailActive.checked = true;
  els.detailStatusMsg.textContent = '';
  els.detailStatusMsg.classList.remove('error');
}

function openCreate() {
  activeInspectorId = null;
  resetForm();
  els.detailTitle.textContent = 'Nový technik';
  els.detailOverlay.classList.add('open');
}

function openEdit(id) {
  const inspector = currentInspectors.find((i) => i.id === id);
  if (!inspector) return;

  activeInspectorId = id;
  resetForm();
  els.detailTitle.textContent = `Upravit: ${inspector.name}`;
  els.detailName.value = inspector.name || '';
  els.detailEmail.value = inspector.email || '';
  els.detailPhone.value = inspector.phone || '';
  els.detailCity.value = inspector.city || '';
  els.detailQualification.value = inspector.qualification || '';
  els.detailInternalNote.value = inspector.internalNote || '';
  els.detailActive.checked = !!inspector.active;
  els.detailOverlay.classList.add('open');
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeInspectorId = null;
}

async function saveInspector() {
  const password = getPassword();
  if (!password) {
    els.detailStatusMsg.textContent = 'Zadejte admin heslo.';
    els.detailStatusMsg.classList.add('error');
    return;
  }
  if (!els.detailName.value.trim()) {
    els.detailStatusMsg.textContent = 'Jméno je povinné.';
    els.detailStatusMsg.classList.add('error');
    return;
  }

  const payload = {
    name: els.detailName.value.trim(),
    email: els.detailEmail.value.trim() || null,
    phone: els.detailPhone.value.trim() || null,
    city: els.detailCity.value.trim() || null,
    qualification: els.detailQualification.value.trim() || null,
    internalNote: els.detailInternalNote.value.trim() || null,
    active: els.detailActive.checked
  };

  els.detailSaveBtn.disabled = true;
  els.detailStatusMsg.textContent = 'Ukládám…';
  els.detailStatusMsg.classList.remove('error');

  try {
    if (activeInspectorId) {
      await adminUpdateInspector(activeInspectorId, payload, password);
    } else {
      await adminCreateInspector(payload, password);
    }
    closeDetail();
    await loadInspectors();
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  } finally {
    els.detailSaveBtn.disabled = false;
  }
}

async function exportCsv() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  const params = {
    active: els.filterActive.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportInspectorsCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inspectors-${new Date().toISOString().slice(0, 10)}.csv`;
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
  els.filterActive = $('filterActive');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.createBtn = $('createBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('inspectorsTbody');
  els.emptyState = $('emptyState');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailTitle = $('detailTitle');
  els.detailName = $('detailName');
  els.detailEmail = $('detailEmail');
  els.detailPhone = $('detailPhone');
  els.detailCity = $('detailCity');
  els.detailQualification = $('detailQualification');
  els.detailInternalNote = $('detailInternalNote');
  els.detailActive = $('detailActive');
  els.detailStatusMsg = $('detailStatusMsg');
  els.detailSaveBtn = $('detailSaveBtn');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadInspectors);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadInspectors();
  });

  els.refreshBtn.addEventListener('click', loadInspectors);
  els.exportBtn.addEventListener('click', exportCsv);
  els.createBtn.addEventListener('click', openCreate);
  els.filterActive.addEventListener('change', loadInspectors);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadInspectors, 350);
  });

  els.detailClose.addEventListener('click', closeDetail);
  els.detailSaveBtn.addEventListener('click', saveInspector);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadInspectors();
  }
}

document.addEventListener('DOMContentLoaded', init);

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

function adminFetchJobs(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/inspection-jobs${query ? '?' + query : ''}`, { password });
}

function adminFetchJob(id, password) {
  return adminRequest(`/admin/inspection-jobs/${encodeURIComponent(id)}`, { password });
}

function adminUpdateJob(id, payload, password) {
  return adminRequest(`/admin/inspection-jobs/${encodeURIComponent(id)}`, { method: 'PATCH', password, body: payload });
}

function adminFetchChecklist(jobId, password) {
  return adminRequest(`/admin/inspection-jobs/${encodeURIComponent(jobId)}/checklist`, { password });
}

function adminCreateChecklistDefaults(jobId, password) {
  return adminRequest(`/admin/inspection-jobs/${encodeURIComponent(jobId)}/checklist/defaults`, { method: 'POST', password });
}

function adminUpdateChecklistItem(itemId, payload, password) {
  return adminRequest(`/admin/inspection-checklist-items/${encodeURIComponent(itemId)}`, { method: 'PATCH', password, body: payload });
}

function adminFetchInspectors(password) {
  return adminRequest('/admin/inspectors?limit=200', { password });
}

function adminExportJobsCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/inspection-jobs/export.csv${query ? '?' + query : ''}`, {
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
let currentJobs = [];
let inspectorsCache = [];
let activeJobId = null;
let currentChecklist = [];
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

function switchTab(tabName) {
  els.tabButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName));
  els.tabPanels.forEach((panel) => panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === tabName));
}

function inspectorName(id) {
  const inspector = inspectorsCache.find((i) => i.id === id);
  return inspector ? inspector.name : id;
}

function populateInspectorSelect(selected) {
  const select = els.detailInspectorSelect;
  select.innerHTML = '<option value="">— Nepřiřazeno —</option>' +
    inspectorsCache
      .filter((i) => i.active || i.id === selected)
      .map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}${i.city ? ' (' + escapeHtml(i.city) + ')' : ''}</option>`)
      .join('');
  select.value = selected || '';
}

async function loadInspectorsCache(password) {
  try {
    const res = await adminFetchInspectors(password);
    inspectorsCache = res.items || [];
  } catch {
    inspectorsCache = [];
  }
}

async function loadJobs() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    status: els.filterStatus.value,
    search: els.filterSearch.value.trim()
  };

  try {
    if (inspectorsCache.length === 0) await loadInspectorsCache(password);
    const res = await adminFetchJobs(params, password);
    currentJobs = res.items || [];
    renderTable(currentJobs);
    setListStatus(`Načteno ${res.items.length} z ${res.total} osmotra.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentJobs = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst osmotra: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(jobs) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = jobs.length === 0 ? 'block' : 'none';

  for (const job of jobs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(job.createdAt)}</td>
      <td><code>${escapeHtml(job.bookingId)}</code></td>
      <td>${job.inspectorId ? escapeHtml(inspectorName(job.inspectorId)) : '—'}</td>
      <td>${escapeHtml(field(job.location))}</td>
      <td>${job.scheduledAt ? formatDate(job.scheduledAt) : '—'}</td>
      <td><span class="status-badge status-${job.status === 'completed' || job.status === 'checklist_done' ? 'completed' : job.status === 'cancelled' ? 'dismissed' : 'open'}">${escapeHtml(job.status)}</span></td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(job.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

const DETAIL_FIELD_LABELS = {
  id: 'ID',
  bookingId: 'Booking ID',
  createdAt: 'Vytvořeno',
  updatedAt: 'Aktualizováno',
  completedAt: 'Dokončeno'
};

function renderDetail(job) {
  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .filter(([key]) => job[key] !== undefined && job[key] !== '' && job[key] !== null)
    .map(([key, label]) => {
      const value = key.endsWith('At') ? formatDate(job[key]) : job[key];
      return `<div><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></div>`;
    }).join('');

  els.detailStatusSelect.value = job.status;
  populateInspectorSelect(job.inspectorId);
  els.detailScheduledAt.value = job.scheduledAt ? job.scheduledAt.slice(0, 16) : '';
  els.detailLocation.value = job.location || '';
  els.detailCustomerContact.value = job.customerContact || '';
  els.detailInternalNote.value = job.internalNote || '';
}

function renderChecklist(items) {
  currentChecklist = items;

  if (!items || items.length === 0) {
    els.checklistList.innerHTML = '<p style="margin:0;color:var(--text-muted-dark);">Tento job zatím nemá checklist — použijte tlačítko výše.</p>';
    return;
  }

  const byCategory = {};
  for (const item of items) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  els.checklistList.innerHTML = Object.entries(byCategory).map(([category, catItems]) => `
    <h4 style="margin:14px 0 8px;font-size:0.85rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted-dark);">${escapeHtml(category)}</h4>
    ${catItems.map((item) => `
      <div style="display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;font-size:0.88rem;">${escapeHtml(item.label)}</div>
        <select data-item-id="${escapeHtml(item.id)}" data-field="value" style="min-width:120px;">
          <option value="" ${!item.value ? 'selected' : ''}>not_checked</option>
          <option value="ok" ${item.value === 'ok' ? 'selected' : ''}>ok</option>
          <option value="issue" ${item.value === 'issue' ? 'selected' : ''}>issue</option>
        </select>
        <input type="text" data-item-id="${escapeHtml(item.id)}" data-field="comment" value="${escapeHtml(item.comment || '')}" placeholder="Komentář…" style="flex:1;min-width:180px;">
      </div>
    `).join('')}
  `).join('');

  els.checklistList.querySelectorAll('select[data-item-id], input[data-item-id]').forEach((el) => {
    el.addEventListener('change', () => saveChecklistItem(el.getAttribute('data-item-id')));
  });
}

async function saveChecklistItem(itemId) {
  const password = getPassword();
  if (!password) return;

  const valueEl = els.checklistList.querySelector(`select[data-item-id="${itemId}"]`);
  const commentEl = els.checklistList.querySelector(`input[data-item-id="${itemId}"]`);

  els.checklistMsg.textContent = 'Ukládám…';
  els.checklistMsg.classList.remove('error');

  try {
    await adminUpdateChecklistItem(itemId, { value: valueEl.value || null, comment: commentEl.value.trim() || null }, password);
    els.checklistMsg.textContent = 'Uloženo.';
  } catch (err) {
    els.checklistMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.checklistMsg.classList.add('error');
  }
}

async function createDefaults() {
  if (!activeJobId) return;
  const password = getPassword();
  if (!password) return;

  els.createDefaultsBtn.disabled = true;
  els.checklistMsg.textContent = 'Vytvářím…';
  els.checklistMsg.classList.remove('error');

  try {
    const res = await adminCreateChecklistDefaults(activeJobId, password);
    renderChecklist(res.items);
    els.checklistMsg.textContent = res.created ? `Vytvořeno ${res.items.length} položek.` : 'Checklist už existoval — zobrazeny stávající položky.';
  } catch (err) {
    els.checklistMsg.textContent = `Nepodařilo se vytvořit: ${err.message}`;
    els.checklistMsg.classList.add('error');
  } finally {
    els.createDefaultsBtn.disabled = false;
  }
}

async function openDetail(id) {
  const cachedJob = currentJobs.find((j) => j.id === id);
  if (!cachedJob) return;

  activeJobId = id;
  els.detailSummaryMsg.textContent = '';
  els.detailSummaryMsg.classList.remove('error');
  els.checklistMsg.textContent = '';
  els.checklistMsg.classList.remove('error');

  renderDetail(cachedJob);
  switchTab('summary');
  els.detailOverlay.classList.add('open');

  const password = getPassword();
  if (!password) return;

  try {
    const [jobRes, checklistRes] = await Promise.all([
      adminFetchJob(id, password),
      adminFetchChecklist(id, password)
    ]);
    const idx = currentJobs.findIndex((j) => j.id === id);
    if (idx !== -1) currentJobs[idx] = jobRes.item;
    if (activeJobId === id) {
      renderDetail(jobRes.item);
      renderChecklist(checklistRes.items);
    }
  } catch (err) {
    if (activeJobId === id) {
      els.detailSummaryMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailSummaryMsg.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeJobId = null;
}

async function saveJob() {
  if (!activeJobId) return;
  const password = getPassword();
  if (!password) {
    els.detailSummaryMsg.textContent = 'Zadejte admin heslo.';
    els.detailSummaryMsg.classList.add('error');
    return;
  }

  const scheduledAtValue = els.detailScheduledAt.value ? new Date(els.detailScheduledAt.value).toISOString() : null;

  els.detailSaveBtn.disabled = true;
  els.detailSummaryMsg.textContent = 'Ukládám…';
  els.detailSummaryMsg.classList.remove('error');

  try {
    const res = await adminUpdateJob(activeJobId, {
      status: els.detailStatusSelect.value,
      inspectorId: els.detailInspectorSelect.value || null,
      scheduledAt: scheduledAtValue,
      location: els.detailLocation.value.trim() || null,
      customerContact: els.detailCustomerContact.value.trim() || null,
      internalNote: els.detailInternalNote.value.trim() || null
    }, password);

    const idx = currentJobs.findIndex((j) => j.id === activeJobId);
    if (idx !== -1) currentJobs[idx] = res.item;
    renderDetail(res.item);
    renderTable(currentJobs);
    els.detailSummaryMsg.textContent = 'Uloženo.';
  } catch (err) {
    els.detailSummaryMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailSummaryMsg.classList.add('error');
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
    status: els.filterStatus.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportJobsCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inspection-jobs-${new Date().toISOString().slice(0, 10)}.csv`;
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
  els.filterStatus = $('filterStatus');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('jobsTbody');
  els.emptyState = $('emptyState');

  els.tabButtons = document.querySelectorAll('.admin-tab-btn');
  els.tabPanels = document.querySelectorAll('.admin-tab-panel');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailFields = $('detailFields');
  els.detailStatusSelect = $('detailStatusSelect');
  els.detailInspectorSelect = $('detailInspectorSelect');
  els.detailScheduledAt = $('detailScheduledAt');
  els.detailLocation = $('detailLocation');
  els.detailCustomerContact = $('detailCustomerContact');
  els.detailInternalNote = $('detailInternalNote');
  els.detailSummaryMsg = $('detailSummaryMsg');
  els.detailSaveBtn = $('detailSaveBtn');
  els.createDefaultsBtn = $('createDefaultsBtn');
  els.checklistMsg = $('checklistMsg');
  els.checklistList = $('checklistList');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  // Pre-open a specific job when arriving from admin-bookings.html's
  // "Otevřít v Osmotra ↗" link (?jobId=...) — convenience only.
  const urlParams = new URLSearchParams(window.location.search);
  const presetJobId = urlParams.get('jobId');
  if (presetJobId) {
    els.filterSearch.value = presetJobId;
  }

  els.loadBtn.addEventListener('click', loadJobs);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadJobs();
  });

  els.refreshBtn.addEventListener('click', loadJobs);
  els.exportBtn.addEventListener('click', exportCsv);
  els.filterStatus.addEventListener('change', loadJobs);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadJobs, 350);
  });

  els.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailSaveBtn.addEventListener('click', saveJob);
  els.createDefaultsBtn.addEventListener('click', createDefaults);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadJobs().then(() => {
      if (presetJobId) openDetail(presetJobId);
    });
  }
}

document.addEventListener('DOMContentLoaded', init);

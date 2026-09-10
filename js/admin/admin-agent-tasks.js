// Fully self-contained, like admin-bookings.js/admin-payments.js/
// admin-ai-runs.js — does not import anything from js/api/api.js, so
// nothing here can ever affect the other admin pages or public forms.

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

function adminFetchAgentTasks(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/agent-tasks${query ? '?' + query : ''}`, { password });
}

function adminFetchAgentTask(id, password) {
  return adminRequest(`/admin/agent-tasks/${encodeURIComponent(id)}`, { password });
}

function adminUpdateAgentTaskStatus(id, status, password) {
  return adminRequest(`/admin/agent-tasks/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    password,
    body: { status }
  });
}

function adminRunBusinessAgent(agentName, entityType, entityId, password) {
  return adminRequest('/admin/agents/run-business-agent', {
    method: 'POST',
    password,
    body: { agentName, entityType, entityId }
  });
}

function adminExportAgentTasksCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/agent-tasks/export.csv${query ? '?' + query : ''}`, {
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
let currentTasks = [];
let activeTaskId = null;
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

const DETAIL_FIELD_LABELS = {
  id: 'ID',
  createdAt: 'Vytvořeno',
  updatedAt: 'Aktualizováno',
  agentName: 'Agent',
  entityType: 'Typ entity',
  entityId: 'ID entity',
  taskType: 'Typ úkolu',
  title: 'Titulek',
  description: 'Popis',
  suggestedAction: 'Navrhovaná akce',
  status: 'Stav',
  reviewedAt: 'Zkontrolováno',
  completedAt: 'Dokončeno'
};

async function loadTasks() {
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
    const res = await adminFetchAgentTasks(params, password);
    currentTasks = res.items || [];
    renderTable(currentTasks);
    setListStatus(`Načteno ${res.items.length} z ${res.total} tasků.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentTasks = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst tasky: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(tasks) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = tasks.length === 0 ? 'block' : 'none';

  for (const task of tasks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(task.createdAt)}</td>
      <td><span class="type-badge">${escapeHtml(field(task.agentName))}</span></td>
      <td>${escapeHtml(field(task.entityType))} <code>${escapeHtml(field(task.entityId))}</code></td>
      <td>${escapeHtml(field(task.taskType))}</td>
      <td>${escapeHtml(field(task.title))}</td>
      <td><span class="status-badge status-${escapeHtml(task.status)}">${escapeHtml(task.status)}</span></td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(task.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

function renderDetail(task) {
  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .filter(([key]) => task[key] !== undefined && task[key] !== '' && task[key] !== null)
    .map(([key, label]) => {
      const value = key.endsWith('At') ? formatDate(task[key]) : task[key];
      return `<div><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></div>`;
    }).join('');

  if (task.suggestedMessage) {
    els.detailMessageWrap.style.display = 'block';
    els.detailMessage.textContent = task.suggestedMessage;
  } else {
    els.detailMessageWrap.style.display = 'none';
  }

  els.detailMarkReviewedBtn.disabled = task.status !== 'open';
  els.detailMarkCompletedBtn.disabled = task.status === 'completed';
  els.detailDismissBtn.disabled = task.status === 'dismissed';
}

async function openDetail(id) {
  const cachedTask = currentTasks.find((t) => t.id === id);
  if (!cachedTask) return;

  activeTaskId = id;
  els.detailStatusMsg.textContent = '';
  els.detailStatusMsg.classList.remove('error');

  renderDetail(cachedTask);
  els.detailOverlay.classList.add('open');

  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchAgentTask(id, password);
    const idx = currentTasks.findIndex((t) => t.id === id);
    if (idx !== -1) currentTasks[idx] = res.item;
    if (activeTaskId === id) renderDetail(res.item);
  } catch (err) {
    if (activeTaskId === id) {
      els.detailStatusMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailStatusMsg.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeTaskId = null;
}

async function setTaskStatus(status) {
  if (!activeTaskId) return;
  const password = getPassword();
  if (!password) {
    els.detailStatusMsg.textContent = 'Zadejte admin heslo.';
    els.detailStatusMsg.classList.add('error');
    return;
  }

  els.detailStatusMsg.textContent = 'Ukládám…';
  els.detailStatusMsg.classList.remove('error');

  try {
    const res = await adminUpdateAgentTaskStatus(activeTaskId, status, password);
    const idx = currentTasks.findIndex((t) => t.id === activeTaskId);
    if (idx !== -1) {
      currentTasks[idx] = res.task;
      renderTable(currentTasks);
    }
    renderDetail(res.task);
    els.detailStatusMsg.textContent = 'Uloženo.';
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  }
}

async function copySuggestedMessage() {
  const task = currentTasks.find((t) => t.id === activeTaskId);
  if (!task || !task.suggestedMessage) return;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(task.suggestedMessage);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = task.suggestedMessage;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    els.detailStatusMsg.textContent = 'Zkopírováno do schránky.';
    els.detailStatusMsg.classList.remove('error');
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se zkopírovat: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  }
}

async function runAgentAdHoc() {
  const password = getPassword();
  if (!password) {
    els.runAgentMsg.textContent = 'Zadejte admin heslo.';
    els.runAgentMsg.classList.add('error');
    return;
  }

  const agentName = els.runAgentSelect.value;
  const entityType = els.runEntityType.value;
  const entityId = els.runEntityId.value.trim();
  if (!entityId) {
    els.runAgentMsg.textContent = 'Zadejte ID entity.';
    els.runAgentMsg.classList.add('error');
    return;
  }

  els.runAgentBtn.disabled = true;
  els.runAgentMsg.textContent = 'Spouštím agenta (mock provider)…';
  els.runAgentMsg.classList.remove('error');

  try {
    const res = await adminRunBusinessAgent(agentName, entityType, entityId, password);
    els.runAgentMsg.textContent = `Vytvořeno ${res.tasks.length} task(ů).`;
    await loadTasks();
  } catch (err) {
    els.runAgentMsg.textContent = `Nepodařilo se spustit agenta: ${err.message}`;
    els.runAgentMsg.classList.add('error');
  } finally {
    els.runAgentBtn.disabled = false;
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
    const blob = await adminExportAgentTasksCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-tasks-${new Date().toISOString().slice(0, 10)}.csv`;
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
  els.tbody = $('agentTasksTbody');
  els.emptyState = $('emptyState');

  els.runAgentSelect = $('runAgentSelect');
  els.runEntityType = $('runEntityType');
  els.runEntityId = $('runEntityId');
  els.runAgentBtn = $('runAgentBtn');
  els.runAgentMsg = $('runAgentMsg');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailFields = $('detailFields');
  els.detailMessageWrap = $('detailMessageWrap');
  els.detailMessage = $('detailMessage');
  els.detailCopyBtn = $('detailCopyBtn');
  els.detailMarkReviewedBtn = $('detailMarkReviewedBtn');
  els.detailMarkCompletedBtn = $('detailMarkCompletedBtn');
  els.detailDismissBtn = $('detailDismissBtn');
  els.detailStatusMsg = $('detailStatusMsg');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  // Pre-fill when arriving from a "Generate follow-up"/"Suggest next
  // step"/"Analyze payment issue" button elsewhere (?entityType=...&
  // entityId=...) — convenience only, doesn't change what's fetched
  // beyond what the filter/run-panel inputs already support.
  const urlParams = new URLSearchParams(window.location.search);
  const presetEntityType = urlParams.get('entityType');
  const presetEntityId = urlParams.get('entityId');
  const presetAgentName = urlParams.get('agentName');
  if (presetEntityType && Array.from(els.runEntityType.options).some((o) => o.value === presetEntityType)) {
    els.runEntityType.value = presetEntityType;
    els.filterEntityType.value = presetEntityType;
  }
  if (presetEntityId) {
    els.runEntityId.value = presetEntityId;
    els.filterSearch.value = presetEntityId;
  }
  if (presetAgentName && Array.from(els.runAgentSelect.options).some((o) => o.value === presetAgentName)) {
    els.runAgentSelect.value = presetAgentName;
  }

  els.loadBtn.addEventListener('click', loadTasks);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadTasks();
  });

  els.refreshBtn.addEventListener('click', loadTasks);
  els.exportBtn.addEventListener('click', exportCsv);
  els.filterAgentName.addEventListener('change', loadTasks);
  els.filterStatus.addEventListener('change', loadTasks);
  els.filterEntityType.addEventListener('change', loadTasks);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadTasks, 350);
  });

  els.runAgentBtn.addEventListener('click', runAgentAdHoc);

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailCopyBtn.addEventListener('click', copySuggestedMessage);
  els.detailMarkReviewedBtn.addEventListener('click', () => setTaskStatus('reviewed'));
  els.detailMarkCompletedBtn.addEventListener('click', () => setTaskStatus('completed'));
  els.detailDismissBtn.addEventListener('click', () => setTaskStatus('dismissed'));
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadTasks();
  }
}

document.addEventListener('DOMContentLoaded', init);

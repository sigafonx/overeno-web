// Fully self-contained, like admin-bookings.js — does not import anything
// from js/api/api.js, so nothing here can ever affect the other admin
// pages or the public forms.

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

function adminFetchAgents(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/agents${query ? '?' + query : ''}`, { password });
}

function adminFetchAgent(id, password) {
  return adminRequest(`/admin/agents/${encodeURIComponent(id)}`, { password });
}

function adminCreateAgent(payload, password) {
  return adminRequest('/admin/agents', { method: 'POST', password, body: payload });
}

function adminUpdateAgent(id, payload, password) {
  return adminRequest(`/admin/agents/${encodeURIComponent(id)}`, { method: 'PATCH', password, body: payload });
}

// ---------------------------------------------------------------------------
// Page logic
// ---------------------------------------------------------------------------

const els = {};
let currentAgents = [];
let activeAgentId = null;
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

async function loadAgents() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    role: els.filterRole.value,
    active: els.filterActive.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchAgents(params, password);
    currentAgents = res.items || [];
    renderTable(currentAgents);
    setListStatus(`Načteno ${res.items.length} z ${res.total} agentů.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentAgents = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst agenty: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(agents) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = agents.length === 0 ? 'block' : 'none';

  for (const agent of agents) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(field(agent.name))}</td>
      <td><span class="type-badge">${escapeHtml(field(agent.role))}</span></td>
      <td>${escapeHtml(field(agent.email))}</td>
      <td>${agent.active ? '<span class="status-badge status-paid">active</span>' : '<span class="status-badge status-cancelled">inactive</span>'}</td>
      <td>${formatDate(agent.createdAt)}</td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(agent.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

function renderDetail(agent) {
  els.detailName.value = agent.name || '';
  els.detailRole.value = agent.role || 'sales_agent';
  els.detailEmail.value = agent.email || '';
  els.detailActive.checked = !!agent.active;
}

async function openDetail(id) {
  const cachedAgent = currentAgents.find((a) => a.id === id);
  if (!cachedAgent) return;

  activeAgentId = id;
  els.detailStatusMsg.textContent = '';
  els.detailStatusMsg.classList.remove('error');

  renderDetail(cachedAgent);
  els.detailOverlay.classList.add('open');

  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchAgent(id, password);
    const fresh = res.item;
    const idx = currentAgents.findIndex((a) => a.id === id);
    if (idx !== -1) currentAgents[idx] = fresh;
    if (activeAgentId === id) renderDetail(fresh);
  } catch (err) {
    if (activeAgentId === id) {
      els.detailStatusMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailStatusMsg.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeAgentId = null;
}

async function saveDetail() {
  if (!activeAgentId) return;
  const password = getPassword();
  if (!password) {
    els.detailStatusMsg.textContent = 'Zadejte admin heslo.';
    els.detailStatusMsg.classList.add('error');
    return;
  }

  const payload = {
    name: els.detailName.value,
    role: els.detailRole.value,
    email: els.detailEmail.value,
    active: els.detailActive.checked
  };

  els.detailSave.disabled = true;
  els.detailStatusMsg.textContent = 'Ukládám…';
  els.detailStatusMsg.classList.remove('error');

  try {
    const res = await adminUpdateAgent(activeAgentId, payload, password);
    const idx = currentAgents.findIndex((a) => a.id === activeAgentId);
    if (idx !== -1) {
      currentAgents[idx] = res.agent;
      renderTable(currentAgents);
    }
    els.detailStatusMsg.textContent = 'Uloženo.';
  } catch (err) {
    if (err.status === 401) {
      els.detailStatusMsg.textContent = 'Neplatné admin heslo.';
    } else if (err.status === 404) {
      els.detailStatusMsg.textContent = 'Agent už neexistuje.';
    } else {
      els.detailStatusMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    }
    els.detailStatusMsg.classList.add('error');
  } finally {
    els.detailSave.disabled = false;
  }
}

async function createAgent() {
  const password = getPassword();
  if (!password) {
    els.createAgentStatus.textContent = 'Zadejte admin heslo.';
    els.createAgentStatus.classList.add('error');
    return;
  }

  const payload = {
    name: els.newAgentName.value,
    role: els.newAgentRole.value,
    email: els.newAgentEmail.value
  };

  els.createAgentBtn.disabled = true;
  els.createAgentStatus.textContent = 'Vytvářím…';
  els.createAgentStatus.classList.remove('error');

  try {
    await adminCreateAgent(payload, password);
    els.createAgentStatus.textContent = 'Agent vytvořen.';
    els.newAgentName.value = '';
    els.newAgentEmail.value = '';
    await loadAgents();
  } catch (err) {
    els.createAgentStatus.textContent = `Nepodařilo se vytvořit: ${err.message}`;
    els.createAgentStatus.classList.add('error');
  } finally {
    els.createAgentBtn.disabled = false;
  }
}

function init() {
  els.passwordInput = $('adminPasswordInput');
  els.loadBtn = $('loadBtn');
  els.authNote = $('authNote');
  els.filterRole = $('filterRole');
  els.filterActive = $('filterActive');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('agentsTbody');
  els.emptyState = $('emptyState');

  els.newAgentName = $('newAgentName');
  els.newAgentRole = $('newAgentRole');
  els.newAgentEmail = $('newAgentEmail');
  els.createAgentBtn = $('createAgentBtn');
  els.createAgentStatus = $('createAgentStatus');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailName = $('detailName');
  els.detailRole = $('detailRole');
  els.detailEmail = $('detailEmail');
  els.detailActive = $('detailActive');
  els.detailStatusMsg = $('detailStatusMsg');
  els.detailSave = $('detailSave');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadAgents);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadAgents();
  });

  els.refreshBtn.addEventListener('click', loadAgents);
  els.filterRole.addEventListener('change', loadAgents);
  els.filterActive.addEventListener('change', loadAgents);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadAgents, 350);
  });

  els.createAgentBtn.addEventListener('click', createAgent);

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailSave.addEventListener('click', saveDetail);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadAgents();
  }
}

document.addEventListener('DOMContentLoaded', init);

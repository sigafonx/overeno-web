import {
  adminFetchLeads,
  adminFetchLead,
  adminUpdateLeadStatus,
  adminUpdateLeadNote,
  adminDeleteLead,
  adminExportLeadsCsv,
  adminFetchAllAgentsForAssignment,
  adminAssignLead,
  adminRunBusinessAgent
} from '../api/api.js';

const SESSION_KEY = 'overeno_admin_password';

const els = {};
let currentLeads = [];
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

// ---------------------------------------------------------------------------
// Loading & rendering the list
// ---------------------------------------------------------------------------

/** Loads every agent (active + inactive) once per successful list load, so
 * the table's Agent column and the detail dropdown both have names ready
 * without an extra round-trip when a detail happens to be opened. Safe to
 * call repeatedly — cheap GET, and a failure here just leaves the table
 * showing raw ids/dashes instead of names, nothing breaks. */
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

async function loadLeads() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    type: els.filterType.value,
    status: els.filterStatus.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchLeads(params, password);
    currentLeads = res.items || [];
    await loadAgentOptions(password);
    renderTable(currentLeads);
    setListStatus(`Načteno ${res.items.length} z ${res.total} leadů.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentLeads = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst leady: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(leads) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = leads.length === 0 ? 'block' : 'none';

  for (const lead of leads) {
    const tr = document.createElement('tr');
    const name = lead.companyName || lead.contactName || '—';
    const agent = agentNameFor(lead.assignedAgentId);
    const agentCell = agent
      ? `${escapeHtml(agent.name)}${agent.active ? '' : ' <span class="status-badge status-cancelled">inactive</span>'}`
      : '—';
    tr.innerHTML = `
      <td>${formatDate(lead.createdAt)}</td>
      <td><span class="type-badge">${escapeHtml(lead.type)}</span></td>
      <td><span class="status-badge status-${escapeHtml(lead.status)}">${escapeHtml(lead.status)}</span></td>
      <td>${escapeHtml(name)}</td>
      <td>${escapeHtml(lead.email)}</td>
      <td>${escapeHtml(lead.city || '—')}</td>
      <td>${agentCell}</td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(lead.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

// ---------------------------------------------------------------------------
// Detail / edit modal
// ---------------------------------------------------------------------------

const DETAIL_FIELD_LABELS = {
  id: 'ID',
  type: 'Typ',
  companyName: 'Firma',
  contactName: 'Kontakt',
  email: 'E-mail',
  phone: 'Telefon',
  city: 'Město',
  vehiclesCount: 'Počet vozů',
  qualification: 'Kvalifikace',
  availability: 'Dostupnost',
  language: 'Jazyk',
  source: 'Zdroj',
  message: 'Zpráva',
  createdAt: 'Vytvořeno',
  updatedAt: 'Aktualizováno'
};

let activeLeadId = null;

function renderDetail(lead) {
  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .filter(([key]) => lead[key] !== undefined && lead[key] !== '')
    .map(([key, label]) => `
      <div><span class="k">${escapeHtml(label)}</span><span class="v">${key.endsWith('At') ? formatDate(lead[key]) : escapeHtml(lead[key])}</span></div>
    `).join('');

  els.detailStatus.value = lead.status || 'new';
  els.detailNote.value = lead.internalNote || '';
  populateAgentSelect(els.detailAssignedAgent, lead.assignedAgentId);
}

async function openDetail(id) {
  const cachedLead = currentLeads.find((l) => l.id === id);
  if (!cachedLead) return;

  activeLeadId = id;
  els.detailStatusMsg.textContent = '';
  els.detailStatusMsg.classList.remove('error');
  els.detailFollowUpMsg.textContent = '';
  els.detailFollowUpMsg.classList.remove('error');

  // Render immediately from whatever the list already has, so the modal
  // isn't empty while the fresh fetch below is in flight.
  renderDetail(cachedLead);
  els.detailOverlay.classList.add('open');

  // Always confirm against the server on open — not just the list's
  // cached copy — so status/note reflect what's actually saved, even if
  // it changed elsewhere since the list was last loaded.
  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchLead(id, password);
    const fresh = res.item;
    const idx = currentLeads.findIndex((l) => l.id === id);
    if (idx !== -1) currentLeads[idx] = fresh;
    if (activeLeadId === id) renderDetail(fresh); // guard: modal might have moved on already
  } catch (err) {
    if (activeLeadId === id) {
      els.detailStatusMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailStatusMsg.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeLeadId = null;
}

async function saveDetail() {
  if (!activeLeadId) return;
  const password = getPassword();
  const status = els.detailStatus.value;
  const note = els.detailNote.value;
  const assignedAgentId = els.detailAssignedAgent.value || null;

  els.detailSave.disabled = true;
  els.detailStatusMsg.textContent = 'Ukládám…';
  els.detailStatusMsg.classList.remove('error');

  try {
    await adminUpdateLeadStatus(activeLeadId, status, password);
    await adminUpdateLeadNote(activeLeadId, note, password);
    await adminAssignLead(activeLeadId, assignedAgentId, password);
    els.detailStatusMsg.textContent = 'Uloženo.';
    await loadLeads();
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  } finally {
    els.detailSave.disabled = false;
  }
}

async function deleteDetail() {
  if (!activeLeadId) return;
  if (!confirm('Opravdu trvale smazat tento lead?')) return;

  const password = getPassword();
  els.detailDelete.disabled = true;

  try {
    await adminDeleteLead(activeLeadId, password);
    closeDetail();
    await loadLeads();
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se smazat: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  } finally {
    els.detailDelete.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

async function exportCsv() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  // Export respects whatever is currently in the filter fields, so the
  // downloaded CSV matches what's on screen.
  const params = {
    type: els.filterType.value,
    status: els.filterStatus.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportLeadsCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setListStatus(`Export se nezdařil: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function generateFollowUp() {
  if (!activeLeadId) return;
  const password = getPassword();
  if (!password) {
    els.detailFollowUpMsg.textContent = 'Zadejte admin heslo.';
    els.detailFollowUpMsg.classList.add('error');
    return;
  }

  els.detailGenerateFollowUpBtn.disabled = true;
  els.detailFollowUpMsg.textContent = 'Generuji návrh (mock provider)…';
  els.detailFollowUpMsg.classList.remove('error');

  try {
    const res = await adminRunBusinessAgent('crm_follow_up', 'lead', activeLeadId, password);
    const link = `admin-agent-tasks.html?entityType=lead&entityId=${encodeURIComponent(activeLeadId)}`;
    els.detailFollowUpMsg.innerHTML = `Vytvořeno ${res.tasks.length} task(ů). <a href="${link}" target="_blank" rel="noopener">Otevřít v Agent tasks ↗</a>`;
  } catch (err) {
    els.detailFollowUpMsg.textContent = `Nepodařilo se vygenerovat návrh: ${err.message}`;
    els.detailFollowUpMsg.classList.add('error');
  } finally {
    els.detailGenerateFollowUpBtn.disabled = false;
  }
}

function init() {
  els.passwordInput = $('adminPasswordInput');
  els.loadBtn = $('loadBtn');
  els.authNote = $('authNote');
  els.filterType = $('filterType');
  els.filterStatus = $('filterStatus');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('leadsTbody');
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
  els.detailGenerateFollowUpBtn = $('detailGenerateFollowUpBtn');
  els.detailFollowUpMsg = $('detailFollowUpMsg');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadLeads);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadLeads();
  });

  els.refreshBtn.addEventListener('click', loadLeads);
  els.filterType.addEventListener('change', loadLeads);
  els.filterStatus.addEventListener('change', loadLeads);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadLeads, 350);
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
  els.detailGenerateFollowUpBtn.addEventListener('click', generateFollowUp);

  // Auto-load if a password is already remembered for this browser tab.
  if (savedPassword) {
    loadLeads();
  }
}

document.addEventListener('DOMContentLoaded', init);

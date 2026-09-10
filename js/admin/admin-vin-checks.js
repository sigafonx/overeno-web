import { adminFetchVinChecks, adminFetchVinCheck, adminExportVinChecksCsv, adminUpdateVinCheckNote, adminFetchAllAgentsForAssignment, adminAssignVinCheck, adminRunVinProvider, adminFetchVinProviderRuns } from '../api/api.js';

const SESSION_KEY = 'overeno_admin_password';

const els = {};
let currentItems = [];
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

/** Never trust `result` to be present or complete — records could in
 * theory be partial (e.g. hand-edited data files), so every field read
 * here has a safe "—" fallback rather than throwing. */
function field(value) {
  return value === undefined || value === null || value === '' ? '—' : value;
}

async function loadVinChecks() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    riskLevel: els.filterRisk.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchVinChecks(params, password);
    currentItems = res.items || [];
    await loadAgentOptions(password);
    renderTable(currentItems);
    setListStatus(`Načteno ${res.items.length} z ${res.total} VIN kontrol.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentItems = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst VIN kontroly: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(items) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = items.length === 0 ? 'block' : 'none';

  for (const record of items) {
    const result = record.result || {};
    const agent = agentNameFor(record.assignedAgentId);
    const agentCell = agent
      ? `${escapeHtml(agent.name)}${agent.active ? '' : ' <span class="status-badge status-cancelled">inactive</span>'}`
      : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(record.createdAt)}</td>
      <td><span class="type-badge">${escapeHtml(field(record.id))}</span></td>
      <td>${escapeHtml(field(record.vin))}</td>
      <td>${escapeHtml(field(result.score))}</td>
      <td>${result.riskLevel ? `<span class="risk-badge risk-${escapeHtml(result.riskLevel)}">${escapeHtml(result.riskLevel)}</span>` : '—'}</td>
      <td>${escapeHtml(field(result.year))}</td>
      <td>${escapeHtml(field(result.estimatedMileage))}</td>
      <td>${escapeHtml(field(result.advertisedMileage))}</td>
      <td>${escapeHtml(field(result.accidents))}</td>
      <td>${escapeHtml(field(result.owners))}</td>
      <td>${escapeHtml(field(result.odometerRisk))}</td>
      <td>${escapeHtml(field(record.language))}</td>
      <td>${escapeHtml(field(record.source))}</td>
      <td>${result.isDemoResult ? '<span class="demo-badge">Demo</span>' : '—'}</td>
      <td>${record.paymentStatus === 'paid' ? '<span class="status-badge status-paid">paid</span>' : '—'}</td>
      <td>${agentCell}</td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(record.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

const DETAIL_FIELD_LABELS = {
  id: 'ID',
  status: 'Stav',
  createdAt: 'Vytvořeno',
  updatedAt: 'Aktualizováno',
  vin: 'VIN',
  language: 'Jazyk',
  source: 'Zdroj',
  pageUrl: 'URL stránky',
  score: 'Skóre',
  riskLevel: 'Úroveň rizika',
  year: 'Rok výroby',
  estimatedMileage: 'Odhad km',
  advertisedMileage: 'Km v inzerátu',
  accidents: 'Nehody',
  owners: 'Počet majitelů',
  odometerRisk: 'Riziko stočení tachometru',
  verdictKey: 'Verdikt (klíč)',
  isDemoResult: 'Demo výsledek',
  disclaimer: 'Disclaimer',
  paymentStatus: 'Stav platby',
  paidAt: 'Zaplaceno',
  paymentId: 'ID platby (viz admin-payments.html)'
};

let activeRecordId = null;
let currentVinProviderMode = 'demo';

function renderDetail(record) {
  // Flatten record + its (possibly missing) result into one object so the
  // field list below can read everything uniformly.
  const flat = {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    vin: record.vin,
    language: record.language,
    source: record.source,
    pageUrl: record.pageUrl,
    paymentStatus: record.paymentStatus,
    paidAt: record.paidAt,
    paymentId: record.paymentId,
    ...(record.result || {})
  };

  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .map(([key, label]) => {
      let value = flat[key];
      if (key.endsWith('At')) value = formatDate(value);
      else if (key === 'isDemoResult') value = value ? 'true' : 'false';
      return `<div><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(field(value))}</span></div>`;
    })
    .join('');

  els.detailNote.value = record.internalNote || '';
  populateAgentSelect(els.detailAssignedAgent, record.assignedAgentId);
}

function renderVinProviderPanel(vinProviderMode, runs) {
  currentVinProviderMode = vinProviderMode || 'demo';

  if (currentVinProviderMode === 'demo') {
    els.vinProviderModeNote.textContent = 'VIN_PROVIDER=demo — žádný reálný provider není nakonfigurovaný. Tenhle VIN check už má demo výsledek z veřejného formuláře.';
    els.vinRunProviderBtn.style.display = 'none';
  } else {
    els.vinProviderModeNote.textContent = `VIN_PROVIDER=${currentVinProviderMode}${currentVinProviderMode === 'mock_real' ? ' (simulace pro testování — bez sítě, bez nákladů, výsledek zůstává demo)' : ' — skutečné volání, může stát peníze, jen pro zaplacené VIN checky'}.`;
    els.vinRunProviderBtn.style.display = 'inline-block';
  }

  if (!runs || runs.length === 0) {
    els.vinProviderRunsList.innerHTML = '<p style="margin:0;font-size:0.8rem;color:var(--text-muted-dark);">Zatím žádné provider runs.</p>';
    return;
  }

  els.vinProviderRunsList.innerHTML = runs.map((run) => {
    let normalizedHtml = '';
    if (run.normalizedJson) {
      try {
        const n = JSON.parse(run.normalizedJson);
        normalizedHtml = `
          <div style="margin-top:6px;font-size:0.78rem;">
            <div><span class="k">Score</span> <span class="v">${escapeHtml(field(n.score))}</span> ·
                 <span class="k">Risk</span> <span class="v">${escapeHtml(field(n.riskLevel))}</span> ·
                 <span class="k">isDemoResult</span> <span class="v">${n.isDemoResult ? 'true' : 'false'}</span></div>
            <div style="margin-top:4px;color:var(--text-muted-dark);">${escapeHtml(n.disclaimer || '')}</div>
            ${Array.isArray(n.risks) && n.risks.length > 0 ? `<ul style="margin:6px 0 0 18px;padding:0;">${n.risks.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
          </div>`;
      } catch {
        normalizedHtml = '<div style="margin-top:6px;font-size:0.78rem;color:var(--brick);">(normalized data could not be displayed)</div>';
      }
    }
    const errorHtml = run.errorMessage
      ? `<div style="margin-top:6px;font-size:0.78rem;color:var(--brick);">Chyba: ${escapeHtml(run.errorMessage)}</div>`
      : '';

    return `
      <div style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
        <span class="v">${formatDate(run.createdAt)}</span> ·
        <span class="status-badge status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span> ·
        <code>${escapeHtml(run.provider)}</code>
        ${run.costEstimate ? ` · <span style="color:var(--text-muted-dark);font-size:0.78rem;">${escapeHtml(run.costEstimate)}</span>` : ''}
        ${normalizedHtml}
        ${errorHtml}
      </div>`;
    // Note: raw request/response JSON is intentionally NOT rendered here
    // — normalized data + status + cost + error is what the admin needs
    // day-to-day; the raw payload stays in the API response / database
    // for anyone who specifically needs to debug it, not surfaced by
    // default in this panel.
  }).join('');
}

async function runVinProvider() {
  if (!activeRecordId) return;
  const password = getPassword();
  if (!password) {
    els.vinRunProviderMsg.textContent = 'Zadejte admin heslo.';
    els.vinRunProviderMsg.classList.add('error');
    return;
  }

  els.vinRunProviderBtn.disabled = true;
  els.vinRunProviderMsg.textContent = 'Spouštím provider…';
  els.vinRunProviderMsg.classList.remove('error');

  try {
    await adminRunVinProvider(activeRecordId, password);
    const runsRes = await adminFetchVinProviderRuns(activeRecordId, password);
    renderVinProviderPanel(currentVinProviderMode, runsRes.items);
    els.vinRunProviderMsg.textContent = 'Hotovo — viz výsledek níže.';
  } catch (err) {
    els.vinRunProviderMsg.textContent = `Nepodařilo se spustit provider: ${err.message}`;
    els.vinRunProviderMsg.classList.add('error');
  } finally {
    els.vinRunProviderBtn.disabled = false;
  }
}

async function openDetail(id) {
  const cachedRecord = currentItems.find((r) => r.id === id);
  if (!cachedRecord) return;

  activeRecordId = id;
  els.detailNoteStatus.textContent = '';
  els.detailNoteStatus.classList.remove('error');
  els.vinRunProviderMsg.textContent = '';
  els.vinRunProviderMsg.classList.remove('error');
  els.vinProviderRunsList.innerHTML = '';

  // Render immediately from whatever the list already has, so the modal
  // isn't empty while the fresh fetch below is in flight.
  renderDetail(cachedRecord);
  els.detailOverlay.classList.add('open');

  // Always confirm against the server on open — not just the list's
  // cached copy — so internalNote/paymentStatus/paidAt/paymentId/result
  // reflect what's actually saved right now.
  const password = getPassword();
  if (!password) return;

  try {
    const res = await adminFetchVinCheck(id, password);
    const fresh = res.item;
    const idx = currentItems.findIndex((r) => r.id === id);
    if (idx !== -1) currentItems[idx] = fresh;
    if (activeRecordId === id) {
      renderDetail(fresh); // guard: modal might have moved on already

      try {
        const runsRes = await adminFetchVinProviderRuns(id, password);
        if (activeRecordId === id) renderVinProviderPanel(res.vinProviderMode, runsRes.items);
      } catch (runsErr) {
        if (activeRecordId === id) {
          els.vinProviderRunsList.innerHTML = `<p style="margin:0;font-size:0.8rem;color:var(--brick);">Nepodařilo se načíst provider runs: ${escapeHtml(runsErr.message)}</p>`;
        }
      }
    }
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
    const res = await adminUpdateVinCheckNote(activeRecordId, internalNote, password);
    await adminAssignVinCheck(activeRecordId, assignedAgentId, password);
    const updated = res.vinCheck;

    // Keep the in-memory list in sync so re-opening this row later (without
    // a full reload) shows the note that was actually just saved.
    const idx = currentItems.findIndex((r) => r.id === activeRecordId);
    if (idx !== -1) currentItems[idx] = { ...currentItems[idx], internalNote: updated.internalNote, updatedAt: updated.updatedAt, assignedAgentId };
    renderTable(currentItems);

    els.detailNoteStatus.textContent = 'Uloženo.';
  } catch (err) {
    if (err.status === 401) {
      els.detailNoteStatus.textContent = 'Neplatné admin heslo.';
    } else if (err.status === 404) {
      els.detailNoteStatus.textContent = 'VIN kontrola už neexistuje.';
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

  // Export respects whatever is currently in the filter fields, so the
  // downloaded CSV matches what's on screen.
  const params = {
    riskLevel: els.filterRisk.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportVinChecksCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vin-checks-${new Date().toISOString().slice(0, 10)}.csv`;
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
  els.filterRisk = $('filterRisk');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('vinChecksTbody');
  els.emptyState = $('emptyState');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailFields = $('detailFields');
  els.detailNote = $('detailNote');
  els.detailAssignedAgent = $('detailAssignedAgent');
  els.detailNoteStatus = $('detailNoteStatus');
  els.detailNoteSave = $('detailNoteSave');
  els.vinProviderModeNote = $('vinProviderModeNote');
  els.vinRunProviderBtn = $('vinRunProviderBtn');
  els.vinRunProviderMsg = $('vinRunProviderMsg');
  els.vinProviderRunsList = $('vinProviderRunsList');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadVinChecks);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadVinChecks();
  });

  els.refreshBtn.addEventListener('click', loadVinChecks);
  els.filterRisk.addEventListener('change', loadVinChecks);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadVinChecks, 350);
  });

  els.exportBtn.addEventListener('click', exportCsv);

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailNoteSave.addEventListener('click', saveNote);
  els.vinRunProviderBtn.addEventListener('click', runVinProvider);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadVinChecks();
  }
}

document.addEventListener('DOMContentLoaded', init);

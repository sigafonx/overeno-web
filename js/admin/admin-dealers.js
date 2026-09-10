// Fully self-contained, like admin-inspectors.js/admin-inspection-jobs.js
// — does not import anything from js/api/api.js.

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

function adminFetchDealers(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/dealers${query ? '?' + query : ''}`, { password });
}

function adminFetchDealer(id, password) {
  return adminRequest(`/admin/dealers/${encodeURIComponent(id)}`, { password });
}

function adminCreateDealer(payload, password) {
  return adminRequest('/admin/dealers', { method: 'POST', password, body: payload });
}

function adminUpdateDealer(id, payload, password) {
  return adminRequest(`/admin/dealers/${encodeURIComponent(id)}`, { method: 'PATCH', password, body: payload });
}

function adminCreateDealerFromLead(leadId, password) {
  return adminRequest(`/admin/dealers/from-lead/${encodeURIComponent(leadId)}`, { method: 'POST', password });
}

function adminFetchDealerRequestLeads(password) {
  return adminRequest('/admin/leads?type=dealer_request&limit=100', { password });
}

function adminFetchVehiclesForDealer(dealerId, password) {
  return adminRequest(`/admin/dealer-vehicles?dealerId=${encodeURIComponent(dealerId)}`, { password });
}

function adminCreateVehicle(payload, password) {
  return adminRequest('/admin/dealer-vehicles', { method: 'POST', password, body: payload });
}

function adminExportDealersCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/dealers/export.csv${query ? '?' + query : ''}`, {
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
let currentDealers = [];
let activeDealerId = null; // null = create mode
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

function statusBadgeClass(status) {
  if (status === 'verified') return 'completed';
  if (status === 'rejected' || status === 'suspended') return 'dismissed';
  return 'open';
}

function switchTab(tabName) {
  els.tabButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName));
  els.tabPanels.forEach((panel) => panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === tabName));
}

async function loadDealers() {
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
    const res = await adminFetchDealers(params, password);
    currentDealers = res.items || [];
    renderTable(currentDealers);
    setListStatus(`Načteno ${res.items.length} z ${res.total} dealerů.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentDealers = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst dealery: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(dealers) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = dealers.length === 0 ? 'block' : 'none';

  for (const dealer of dealers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(dealer.companyName)}</td>
      <td>${escapeHtml(field(dealer.contactName))}<br><span style="color:var(--text-muted-dark);font-size:0.8rem;">${escapeHtml(field(dealer.email))}</span></td>
      <td>${escapeHtml(field(dealer.city))}</td>
      <td><span class="status-badge status-${statusBadgeClass(dealer.status)}">${escapeHtml(dealer.status)}</span></td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(dealer.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openEdit(btn.getAttribute('data-id')));
  });
}

function resetForm() {
  els.detailCompanyName.value = '';
  els.detailContactName.value = '';
  els.detailEmail.value = '';
  els.detailPhone.value = '';
  els.detailCity.value = '';
  els.detailWebsite.value = '';
  els.detailStatusSelect.value = 'pending';
  els.detailInternalNote.value = '';
  els.detailStatusMsg.textContent = '';
  els.detailStatusMsg.classList.remove('error');
  els.addVehicleForm.style.display = 'none';
  els.vehiclesList.innerHTML = '';
}

function openCreate() {
  activeDealerId = null;
  resetForm();
  els.detailTitle.textContent = 'Nový dealer';
  els.detailTabs.style.display = 'none';
  els.detailStatusFieldWrap.style.display = 'none';
  switchTab('summary');
  els.detailOverlay.classList.add('open');
}

async function openEdit(id) {
  const dealer = currentDealers.find((d) => d.id === id);
  if (!dealer) return;

  activeDealerId = id;
  resetForm();
  els.detailTitle.textContent = dealer.companyName;
  els.detailTabs.style.display = 'flex';
  els.detailStatusFieldWrap.style.display = 'block';
  switchTab('summary');
  populateForm(dealer);
  els.detailOverlay.classList.add('open');

  const password = getPassword();
  if (!password) return;

  try {
    const [dealerRes, vehiclesRes] = await Promise.all([
      adminFetchDealer(id, password),
      adminFetchVehiclesForDealer(id, password)
    ]);
    if (activeDealerId === id) {
      populateForm(dealerRes.item);
      renderVehicles(vehiclesRes.items);
    }
  } catch (err) {
    if (activeDealerId === id) {
      els.detailStatusMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailStatusMsg.classList.add('error');
    }
  }
}

function populateForm(dealer) {
  els.detailCompanyName.value = dealer.companyName || '';
  els.detailContactName.value = dealer.contactName || '';
  els.detailEmail.value = dealer.email || '';
  els.detailPhone.value = dealer.phone || '';
  els.detailCity.value = dealer.city || '';
  els.detailWebsite.value = dealer.website || '';
  els.detailStatusSelect.value = dealer.status || 'pending';
  els.detailInternalNote.value = dealer.internalNote || '';
}

function renderVehicles(vehicles) {
  if (!vehicles || vehicles.length === 0) {
    els.vehiclesList.innerHTML = '<p style="margin:0;color:var(--text-muted-dark);">Tento dealer zatím nemá žádná vozidla.</p>';
    return;
  }
  els.vehiclesList.innerHTML = vehicles.map((v) => `
    <div style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:0.88rem;">
      <strong>${escapeHtml(field(v.make))} ${escapeHtml(field(v.model))}</strong> ${v.year ? '(' + v.year + ')' : ''}
      · <span class="status-badge status-${v.status === 'sold' ? 'dismissed' : 'open'}">${escapeHtml(v.status)}</span>
      <br><code style="font-size:0.78rem;">${escapeHtml(field(v.vin))}</code>
      ${v.listingUrl ? ` · <a href="${escapeHtml(v.listingUrl)}" target="_blank" rel="noopener">inzerát ↗</a>` : ''}
    </div>
  `).join('');
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeDealerId = null;
}

async function saveDealer() {
  const password = getPassword();
  if (!password) {
    els.detailStatusMsg.textContent = 'Zadejte admin heslo.';
    els.detailStatusMsg.classList.add('error');
    return;
  }
  if (!els.detailCompanyName.value.trim()) {
    els.detailStatusMsg.textContent = 'Firma je povinná.';
    els.detailStatusMsg.classList.add('error');
    return;
  }

  const payload = {
    companyName: els.detailCompanyName.value.trim(),
    contactName: els.detailContactName.value.trim() || null,
    email: els.detailEmail.value.trim() || null,
    phone: els.detailPhone.value.trim() || null,
    city: els.detailCity.value.trim() || null,
    website: els.detailWebsite.value.trim() || null,
    internalNote: els.detailInternalNote.value.trim() || null
  };
  if (activeDealerId) {
    payload.status = els.detailStatusSelect.value;
  }

  els.detailSaveBtn.disabled = true;
  els.detailStatusMsg.textContent = 'Ukládám…';
  els.detailStatusMsg.classList.remove('error');

  try {
    if (activeDealerId) {
      await adminUpdateDealer(activeDealerId, payload, password);
    } else {
      await adminCreateDealer(payload, password);
    }
    closeDetail();
    await loadDealers();
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  } finally {
    els.detailSaveBtn.disabled = false;
  }
}

function toggleAddVehicleForm() {
  els.addVehicleForm.style.display = els.addVehicleForm.style.display === 'none' ? 'block' : 'none';
}

async function saveVehicle() {
  if (!activeDealerId) return;
  const password = getPassword();
  if (!password) return;

  els.saveVehicleBtn.disabled = true;
  els.addVehicleMsg.textContent = 'Ukládám…';
  els.addVehicleMsg.classList.remove('error');

  try {
    await adminCreateVehicle({
      dealerId: activeDealerId,
      vin: els.newVehicleVin.value.trim() || null,
      make: els.newVehicleMake.value.trim() || null,
      model: els.newVehicleModel.value.trim() || null,
      year: els.newVehicleYear.value ? Number(els.newVehicleYear.value) : null,
      listingUrl: els.newVehicleListingUrl.value.trim() || null
    }, password);

    els.newVehicleVin.value = '';
    els.newVehicleMake.value = '';
    els.newVehicleModel.value = '';
    els.newVehicleYear.value = '';
    els.newVehicleListingUrl.value = '';
    els.addVehicleForm.style.display = 'none';
    els.addVehicleMsg.textContent = '';

    const res = await adminFetchVehiclesForDealer(activeDealerId, password);
    renderVehicles(res.items);
  } catch (err) {
    els.addVehicleMsg.textContent = `Nepodařilo se uložit vozidlo: ${err.message}`;
    els.addVehicleMsg.classList.add('error');
  } finally {
    els.saveVehicleBtn.disabled = false;
  }
}

async function openFromLeadPicker() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  els.fromLeadMsg.textContent = 'Načítám leady…';
  els.fromLeadMsg.classList.remove('error');
  els.fromLeadList.innerHTML = '';
  els.fromLeadOverlay.classList.add('open');

  try {
    const res = await adminFetchDealerRequestLeads(password);
    if (res.items.length === 0) {
      els.fromLeadMsg.textContent = 'Žádné dealer_request leady zatím nejsou.';
      return;
    }
    els.fromLeadMsg.textContent = '';
    els.fromLeadList.innerHTML = res.items.map((lead) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
        <div style="font-size:0.85rem;">
          <strong>${escapeHtml(field(lead.companyName))}</strong><br>
          <span style="color:var(--text-muted-dark);">${escapeHtml(field(lead.contactName))} · ${escapeHtml(field(lead.email))} · ${escapeHtml(field(lead.city))}</span>
        </div>
        <button type="button" class="btn btn-brass btn-sm" data-lead-id="${escapeHtml(lead.id)}">Vytvořit dealera</button>
      </div>
    `).join('');

    els.fromLeadList.querySelectorAll('button[data-lead-id]').forEach((btn) => {
      btn.addEventListener('click', () => createFromLead(btn.getAttribute('data-lead-id')));
    });
  } catch (err) {
    els.fromLeadMsg.textContent = `Nepodařilo se načíst leady: ${err.message}`;
    els.fromLeadMsg.classList.add('error');
  }
}

async function createFromLead(leadId) {
  const password = getPassword();
  if (!password) return;

  els.fromLeadMsg.textContent = 'Vytvářím…';
  els.fromLeadMsg.classList.remove('error');

  try {
    await adminCreateDealerFromLead(leadId, password);
    els.fromLeadOverlay.classList.remove('open');
    await loadDealers();
  } catch (err) {
    els.fromLeadMsg.textContent = `Nepodařilo se vytvořit dealera: ${err.message}`;
    els.fromLeadMsg.classList.add('error');
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
    const blob = await adminExportDealersCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dealers-${new Date().toISOString().slice(0, 10)}.csv`;
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
  els.createBtn = $('createBtn');
  els.fromLeadBtn = $('fromLeadBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('dealersTbody');
  els.emptyState = $('emptyState');

  els.fromLeadOverlay = $('fromLeadOverlay');
  els.fromLeadClose = $('fromLeadClose');
  els.fromLeadList = $('fromLeadList');
  els.fromLeadMsg = $('fromLeadMsg');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailTitle = $('detailTitle');
  els.detailTabs = $('detailTabs');
  els.tabButtons = document.querySelectorAll('.admin-tab-btn');
  els.tabPanels = document.querySelectorAll('.admin-tab-panel');
  els.detailCompanyName = $('detailCompanyName');
  els.detailContactName = $('detailContactName');
  els.detailEmail = $('detailEmail');
  els.detailPhone = $('detailPhone');
  els.detailCity = $('detailCity');
  els.detailWebsite = $('detailWebsite');
  els.detailStatusFieldWrap = $('detailStatusFieldWrap');
  els.detailStatusSelect = $('detailStatusSelect');
  els.detailInternalNote = $('detailInternalNote');
  els.detailStatusMsg = $('detailStatusMsg');
  els.detailSaveBtn = $('detailSaveBtn');

  els.addVehicleBtn = $('addVehicleBtn');
  els.addVehicleForm = $('addVehicleForm');
  els.newVehicleVin = $('newVehicleVin');
  els.newVehicleMake = $('newVehicleMake');
  els.newVehicleModel = $('newVehicleModel');
  els.newVehicleYear = $('newVehicleYear');
  els.newVehicleListingUrl = $('newVehicleListingUrl');
  els.saveVehicleBtn = $('saveVehicleBtn');
  els.addVehicleMsg = $('addVehicleMsg');
  els.vehiclesList = $('vehiclesList');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadDealers);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadDealers();
  });

  els.refreshBtn.addEventListener('click', loadDealers);
  els.exportBtn.addEventListener('click', exportCsv);
  els.createBtn.addEventListener('click', openCreate);
  els.fromLeadBtn.addEventListener('click', openFromLeadPicker);
  els.filterStatus.addEventListener('change', loadDealers);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadDealers, 350);
  });

  els.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  els.fromLeadClose.addEventListener('click', () => els.fromLeadOverlay.classList.remove('open'));
  els.fromLeadOverlay.addEventListener('click', (e) => {
    if (e.target === els.fromLeadOverlay) els.fromLeadOverlay.classList.remove('open');
  });

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailSaveBtn.addEventListener('click', saveDealer);
  els.addVehicleBtn.addEventListener('click', toggleAddVehicleForm);
  els.saveVehicleBtn.addEventListener('click', saveVehicle);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.detailOverlay.classList.contains('open')) closeDetail();
      if (els.fromLeadOverlay.classList.contains('open')) els.fromLeadOverlay.classList.remove('open');
    }
  });

  if (savedPassword) {
    loadDealers();
  }
}

document.addEventListener('DOMContentLoaded', init);

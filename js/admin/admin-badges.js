// Fully self-contained, like admin-dealers.js/admin-inspection-jobs.js
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

function adminFetchBadges(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/badges${query ? '?' + query : ''}`, { password });
}

function adminFetchBadge(id, password) {
  return adminRequest(`/admin/badges/${encodeURIComponent(id)}`, { password });
}

function adminUpdateBadgeStatus(id, payload, password) {
  return adminRequest(`/admin/badges/${encodeURIComponent(id)}/status`, { method: 'PATCH', password, body: payload });
}

function adminFetchDealerLite(id, password) {
  return adminRequest(`/admin/dealers/${encodeURIComponent(id)}`, { password });
}

function adminFetchVehicleLite(id, password) {
  return adminRequest(`/admin/dealer-vehicles/${encodeURIComponent(id)}`, { password });
}

function adminExportBadgesCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/badges/export.csv${query ? '?' + query : ''}`, {
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
let currentBadges = [];
let vehicleCache = {};
let activeBadgeId = null;
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
  if (status === 'approved') return 'completed';
  if (status === 'rejected' || status === 'revoked' || status === 'expired') return 'dismissed';
  return 'open';
}

function publicBadgeUrl(code) {
  return `badge.html?code=${encodeURIComponent(code)}`;
}

async function vehicleLabel(vehicleId, password) {
  if (vehicleCache[vehicleId]) return vehicleCache[vehicleId];
  try {
    const res = await adminFetchVehicleLite(vehicleId, password);
    const v = res.item;
    const label = [v.make, v.model, v.year].filter(Boolean).join(' ') || v.vin || vehicleId;
    vehicleCache[vehicleId] = label;
    return label;
  } catch {
    return vehicleId;
  }
}

async function loadBadges() {
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
    const res = await adminFetchBadges(params, password);
    currentBadges = res.items || [];
    await renderTable(currentBadges, password);
    setListStatus(`Načteno ${res.items.length} z ${res.total} badges.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentBadges = [];
    await renderTable([], password);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst badges: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

async function renderTable(badges, password) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = badges.length === 0 ? 'block' : 'none';

  for (const badge of badges) {
    const label = await vehicleLabel(badge.vehicleId, password);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(badge.createdAt)}</td>
      <td><code>${escapeHtml(badge.badgeCode)}</code></td>
      <td>${escapeHtml(label)}</td>
      <td>${badge.expiresAt ? formatDate(badge.expiresAt) : '—'}</td>
      <td><span class="status-badge status-${statusBadgeClass(badge.status)}">${escapeHtml(badge.status)}</span></td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(badge.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

async function renderDetail(badge, password) {
  const dealerLabel = badge.dealerId ? (await adminFetchDealerLite(badge.dealerId, password).then((r) => r.item.companyName).catch(() => badge.dealerId)) : '—';
  const vehicleLbl = await vehicleLabel(badge.vehicleId, password);

  const fields = {
    id: badge.id,
    status: badge.status,
    dealer: dealerLabel,
    vehicle: vehicleLbl,
    issuedAt: formatDate(badge.issuedAt),
    expiresAt: formatDate(badge.expiresAt),
    revokedAt: formatDate(badge.revokedAt),
    createdAt: formatDate(badge.createdAt)
  };
  const labels = { id: 'ID', status: 'Stav', dealer: 'Dealer', vehicle: 'Vozidlo', issuedAt: 'Vydáno', expiresAt: 'Vyprší', revokedAt: 'Zrušeno', createdAt: 'Vytvořeno' };

  els.detailFields.innerHTML = Object.entries(fields)
    .filter(([, value]) => value && value !== '—')
    .map(([key, value]) => `<div><span class="k">${escapeHtml(labels[key])}</span><span class="v">${escapeHtml(value)}</span></div>`)
    .join('');

  els.detailBadgeCode.textContent = badge.badgeCode;
  els.publicLinkPreview.textContent = publicBadgeUrl(badge.badgeCode);
  els.publicLinkPreview.href = publicBadgeUrl(badge.badgeCode);
  els.detailExpiresAt.value = badge.expiresAt ? badge.expiresAt.slice(0, 16) : '';
  els.detailInternalNote.value = badge.internalNote || '';

  els.approveBtn.disabled = badge.status === 'approved';
  els.rejectBtn.disabled = badge.status === 'rejected';
  els.revokeBtn.disabled = badge.status !== 'approved';
}

async function openDetail(id) {
  const cachedBadge = currentBadges.find((b) => b.id === id);
  if (!cachedBadge) return;

  activeBadgeId = id;
  els.detailStatusMsg.textContent = '';
  els.detailStatusMsg.classList.remove('error');

  const password = getPassword();
  await renderDetail(cachedBadge, password);
  els.detailOverlay.classList.add('open');

  if (!password) return;

  try {
    const res = await adminFetchBadge(id, password);
    const idx = currentBadges.findIndex((b) => b.id === id);
    if (idx !== -1) currentBadges[idx] = res.item;
    if (activeBadgeId === id) await renderDetail(res.item, password);
  } catch (err) {
    if (activeBadgeId === id) {
      els.detailStatusMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailStatusMsg.classList.add('error');
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeBadgeId = null;
}

async function setBadgeStatus(status) {
  if (!activeBadgeId) return;
  const password = getPassword();
  if (!password) {
    els.detailStatusMsg.textContent = 'Zadejte admin heslo.';
    els.detailStatusMsg.classList.add('error');
    return;
  }

  const payload = { status, internalNote: els.detailInternalNote.value.trim() || null };
  if (status === 'approved' && els.detailExpiresAt.value) {
    payload.expiresAt = new Date(els.detailExpiresAt.value).toISOString();
  }

  els.detailStatusMsg.textContent = 'Ukládám…';
  els.detailStatusMsg.classList.remove('error');

  try {
    const res = await adminUpdateBadgeStatus(activeBadgeId, payload, password);
    const idx = currentBadges.findIndex((b) => b.id === activeBadgeId);
    if (idx !== -1) currentBadges[idx] = res.item;
    await renderDetail(res.item, password);
    await renderTable(currentBadges, password);
    els.detailStatusMsg.textContent = 'Uloženo.';
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  }
}

async function copyCode() {
  const badge = currentBadges.find((b) => b.id === activeBadgeId);
  if (!badge) return;
  await copyToClipboard(badge.badgeCode);
  els.detailStatusMsg.textContent = 'Kód zkopírován.';
  els.detailStatusMsg.classList.remove('error');
}

async function copyLink() {
  const badge = currentBadges.find((b) => b.id === activeBadgeId);
  if (!badge) return;
  const fullUrl = new URL(publicBadgeUrl(badge.badgeCode), window.location.href).href;
  await copyToClipboard(fullUrl);
  els.detailStatusMsg.textContent = 'Odkaz zkopírován.';
  els.detailStatusMsg.classList.remove('error');
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se zkopírovat: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
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
    const blob = await adminExportBadgesCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `badges-${new Date().toISOString().slice(0, 10)}.csv`;
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
  els.tbody = $('badgesTbody');
  els.emptyState = $('emptyState');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailFields = $('detailFields');
  els.detailBadgeCode = $('detailBadgeCode');
  els.publicLinkPreview = $('publicLinkPreview');
  els.copyCodeBtn = $('copyCodeBtn');
  els.copyLinkBtn = $('copyLinkBtn');
  els.detailExpiresAt = $('detailExpiresAt');
  els.detailInternalNote = $('detailInternalNote');
  els.approveBtn = $('approveBtn');
  els.rejectBtn = $('rejectBtn');
  els.revokeBtn = $('revokeBtn');
  els.detailStatusMsg = $('detailStatusMsg');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadBadges);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadBadges();
  });

  els.refreshBtn.addEventListener('click', loadBadges);
  els.exportBtn.addEventListener('click', exportCsv);
  els.filterStatus.addEventListener('change', loadBadges);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadBadges, 350);
  });

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.copyCodeBtn.addEventListener('click', copyCode);
  els.copyLinkBtn.addEventListener('click', copyLink);
  els.approveBtn.addEventListener('click', () => setBadgeStatus('approved'));
  els.rejectBtn.addEventListener('click', () => setBadgeStatus('rejected'));
  els.revokeBtn.addEventListener('click', () => setBadgeStatus('revoked'));
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadBadges();
  }
}

document.addEventListener('DOMContentLoaded', init);

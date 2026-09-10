// Fully self-contained, like admin-dealers.js/admin-badges.js — does
// not import anything from js/api/api.js.

const API_BASE_URL = (window.OVERENO_CONFIG && window.OVERENO_CONFIG.apiBaseUrl) || 'http://localhost:3001';
const ADMIN_HEADER = 'x-admin-password';
const SESSION_KEY = 'overeno_admin_password';

async function adminRequest(path, { method = 'GET', password, body } = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', [ADMIN_HEADER]: password || '' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Request failed with status ${res.status}.`);
    err.status = res.status;
    err.code = data && data.error;
    err.payoutId = data && data.payoutId;
    throw err;
  }
  return data;
}

function fetchCsv(path, password) {
  return fetch(`${API_BASE_URL}${path}`, { headers: { [ADMIN_HEADER]: password || '' } }).then(async (res) => {
    if (!res.ok) throw new Error(`Export failed with status ${res.status}.`);
    return res.blob();
  });
}

const els = {};
let currentPayouts = [];
let activePayoutId = null;

function $(id) { return document.getElementById(id); }
function getPassword() { return els.passwordInput.value.trim(); }
function escapeHtml(v) { const d = document.createElement('div'); d.textContent = v === undefined || v === null ? '' : String(v); return d.innerHTML; }
function field(v) { return v === undefined || v === null || v === '' ? '—' : v; }
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function money(amount, currency) {
  if (amount === undefined || amount === null) return '—';
  return (amount / 100).toFixed(2) + ' ' + (currency || '');
}

function switchTab(tabName) {
  document.querySelectorAll('.admin-tab-btn').forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName));
  document.querySelectorAll('.admin-tab-panel').forEach((panel) => panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === tabName));
}

async function loadSettings() {
  const password = getPassword();
  if (!password) return;
  try {
    const res = await adminRequest('/admin/revenue-share/settings', { password });
    const s = res.settings;
    els.settingsEnabled.checked = s.enabled;
    els.settingsSharePercent.value = s.sharePercent;
    els.settingsTimezone.value = s.timezone;
    els.settingsPayoutDay.value = s.payoutDay;
    els.settingsPayoutTime.value = s.payoutTime;
    els.settingsPayoutMethod.value = s.payoutMethod || '';
    els.settingsPayoutRecipientLabel.value = s.payoutRecipientLabel || '';
    els.settingsPayoutRecipientMasked.value = s.payoutRecipientMasked || '';
    els.settingsNotes.value = s.notes || '';
  } catch (err) {
    els.settingsMsg.textContent = `Nepodařilo se načíst settings: ${err.message}`;
    els.settingsMsg.classList.add('error');
  }
}

async function saveSettings() {
  const password = getPassword();
  if (!password) { els.settingsMsg.textContent = 'Zadejte admin heslo.'; els.settingsMsg.classList.add('error'); return; }

  els.settingsMsg.textContent = 'Ukládám…';
  els.settingsMsg.classList.remove('error');
  try {
    await adminRequest('/admin/revenue-share/settings', {
      method: 'PATCH', password,
      body: {
        enabled: els.settingsEnabled.checked,
        sharePercent: Number(els.settingsSharePercent.value),
        timezone: els.settingsTimezone.value.trim(),
        payoutDay: Number(els.settingsPayoutDay.value),
        payoutTime: els.settingsPayoutTime.value.trim(),
        payoutMethod: els.settingsPayoutMethod.value.trim() || null,
        payoutRecipientLabel: els.settingsPayoutRecipientLabel.value.trim() || null,
        payoutRecipientMasked: els.settingsPayoutRecipientMasked.value.trim() || null,
        notes: els.settingsNotes.value.trim() || null
      }
    });
    els.settingsMsg.textContent = 'Uloženo.';
  } catch (err) {
    els.settingsMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.settingsMsg.classList.add('error');
  }
}

async function loadLedger() {
  const password = getPassword();
  if (!password) { els.ledgerStatus.textContent = 'Zadejte admin heslo.'; return; }
  els.ledgerStatus.textContent = 'Načítám…';
  try {
    const params = new URLSearchParams();
    if (els.ledgerFilterStatus.value) params.set('status', els.ledgerFilterStatus.value);
    if (els.ledgerFilterMonth.value.trim()) params.set('monthKey', els.ledgerFilterMonth.value.trim());
    const res = await adminRequest(`/admin/revenue-share/ledger?${params}`, { password });
    els.ledgerTbody.innerHTML = res.items.map((r) => `
      <tr>
        <td>${formatDate(r.createdAt)}</td>
        <td><code>${escapeHtml(r.paymentId)}</code></td>
        <td>${money(r.paymentAmount, r.currency)}</td>
        <td>${money(r.shareAmount, r.currency)}</td>
        <td>${escapeHtml(r.monthKey)}</td>
        <td><span class="status-badge status-${r.status === 'accrued' ? 'open' : r.status === 'included_in_payout' ? 'completed' : 'dismissed'}">${escapeHtml(r.status)}</span></td>
      </tr>
    `).join('');
    els.ledgerStatus.textContent = `Načteno ${res.items.length} z ${res.total}.`;
  } catch (err) {
    els.ledgerStatus.textContent = `Chyba: ${err.message}`;
  }
}

async function exportLedgerCsv() {
  const password = getPassword();
  if (!password) return;
  try {
    const blob = await fetchCsv('/admin/revenue-share/ledger/export.csv', password);
    downloadBlob(blob, `revenue-share-ledger-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (err) {
    els.ledgerStatus.textContent = `Export se nezdařil: ${err.message}`;
  }
}

async function loadPayouts() {
  const password = getPassword();
  if (!password) { els.payoutsStatus.textContent = 'Zadejte admin heslo.'; return; }
  els.payoutsStatus.textContent = 'Načítám…';
  try {
    const res = await adminRequest('/admin/revenue-share/payouts', { password });
    currentPayouts = res.items;
    els.payoutsTbody.innerHTML = res.items.map((p) => `
      <tr>
        <td>${escapeHtml(p.monthKey)}</td>
        <td>${money(p.grossRevenue, p.currency)}</td>
        <td>${money(p.shareAmount, p.currency)}</td>
        <td>${formatDate(p.payoutDueAt)}</td>
        <td>${escapeHtml(field(p.payoutRecipientMasked))}</td>
        <td><span class="status-badge status-${p.status === 'paid' ? 'completed' : p.status === 'cancelled' ? 'dismissed' : 'open'}">${escapeHtml(p.status)}</span></td>
        <td><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(p.id)}">Detail</button></td>
      </tr>
    `).join('');
    els.payoutsTbody.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
    });
    els.payoutsStatus.textContent = `Načteno ${res.items.length} z ${res.total}.`;
  } catch (err) {
    els.payoutsStatus.textContent = `Chyba: ${err.message}`;
  }
}

async function exportPayoutsCsv() {
  const password = getPassword();
  if (!password) return;
  try {
    const blob = await fetchCsv('/admin/revenue-share/payouts/export.csv', password);
    downloadBlob(blob, `revenue-share-payouts-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (err) {
    els.payoutsStatus.textContent = `Export se nezdařil: ${err.message}`;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function calculatePayout() {
  const password = getPassword();
  if (!password) { els.payoutsStatus.textContent = 'Zadejte admin heslo.'; return; }
  const monthKey = els.calcMonthKey.value.trim();
  if (!monthKey) { els.payoutsStatus.textContent = 'Zadejte monthKey (YYYY-MM).'; return; }

  els.payoutsStatus.textContent = 'Počítám…';
  try {
    const res = await adminRequest('/admin/revenue-share/payouts/calculate', { method: 'POST', password, body: { monthKey } });
    els.payoutsStatus.textContent = `Vytvořeno ${res.payouts.length} payout(ů) pro ${monthKey}.`;
    await loadPayouts();
  } catch (err) {
    els.payoutsStatus.textContent = `Chyba: ${err.message}${err.payoutId ? ' (existující: ' + err.payoutId + ')' : ''}`;
  }
}

function openDetail(id) {
  const payout = currentPayouts.find((p) => p.id === id);
  if (!payout) return;
  activePayoutId = id;
  els.detailMsg.textContent = '';
  els.detailFields.innerHTML = Object.entries({
    ID: payout.id, MonthKey: payout.monthKey, Gross: money(payout.grossRevenue, payout.currency),
    'Share %': payout.sharePercent + '%', Share: money(payout.shareAmount, payout.currency),
    Due: formatDate(payout.payoutDueAt), Method: field(payout.payoutMethod),
    Recipient: field(payout.payoutRecipientMasked), Status: payout.status,
    'Marked paid': formatDate(payout.markedPaidAt)
  }).map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`).join('');
  els.detailInternalNote.value = payout.internalNote || '';
  els.markPaidBtn.disabled = payout.status === 'paid' || payout.status === 'cancelled';
  els.detailOverlay.classList.add('open');
}

function closeDetail() { els.detailOverlay.classList.remove('open'); activePayoutId = null; }

async function saveNote() {
  const password = getPassword();
  if (!password || !activePayoutId) return;
  try {
    await adminRequest(`/admin/revenue-share/payouts/${activePayoutId}/note`, { method: 'PATCH', password, body: { internalNote: els.detailInternalNote.value.trim() || null } });
    els.detailMsg.textContent = 'Poznámka uložena.';
    await loadPayouts();
  } catch (err) {
    els.detailMsg.textContent = `Chyba: ${err.message}`;
  }
}

async function markPaid() {
  const password = getPassword();
  if (!password || !activePayoutId) return;
  try {
    await adminRequest(`/admin/revenue-share/payouts/${activePayoutId}/mark-paid`, { method: 'PATCH', password });
    els.detailMsg.textContent = 'Označeno jako paid.';
    await loadPayouts();
    closeDetail();
  } catch (err) {
    els.detailMsg.textContent = `Chyba: ${err.message}`;
  }
}

function init() {
  els.passwordInput = $('adminPasswordInput');
  els.authNote = $('authNote');
  ['settingsEnabled', 'settingsSharePercent', 'settingsTimezone', 'settingsPayoutDay', 'settingsPayoutTime',
    'settingsPayoutMethod', 'settingsPayoutRecipientLabel', 'settingsPayoutRecipientMasked', 'settingsNotes', 'settingsMsg',
    'ledgerFilterStatus', 'ledgerFilterMonth', 'ledgerStatus', 'ledgerTbody',
    'calcMonthKey', 'payoutsStatus', 'payoutsTbody',
    'detailOverlay', 'detailFields', 'detailInternalNote', 'detailMsg'
  ].forEach((id) => { els[id] = $(id); });

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) els.passwordInput.value = savedPassword;

  $('loadBtn').addEventListener('click', () => {
    sessionStorage.setItem(SESSION_KEY, getPassword());
    loadSettings(); loadLedger(); loadPayouts();
  });
  els.passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loadBtn').click(); });

  document.querySelectorAll('.admin-tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab'))));

  $('settingsSaveBtn').addEventListener('click', saveSettings);
  $('ledgerRefreshBtn').addEventListener('click', loadLedger);
  $('ledgerExportBtn').addEventListener('click', exportLedgerCsv);
  $('payoutsRefreshBtn').addEventListener('click', loadPayouts);
  $('payoutsExportBtn').addEventListener('click', exportPayoutsCsv);
  $('calculateBtn').addEventListener('click', calculatePayout);

  $('detailClose').addEventListener('click', closeDetail);
  $('detailCloseBtn2').addEventListener('click', closeDetail);
  $('saveNoteBtn').addEventListener('click', saveNote);
  $('markPaidBtn').addEventListener('click', markPaid);
  els.detailOverlay.addEventListener('click', (e) => { if (e.target === els.detailOverlay) closeDetail(); });

  if (savedPassword) { loadSettings(); loadLedger(); loadPayouts(); }
}

document.addEventListener('DOMContentLoaded', init);

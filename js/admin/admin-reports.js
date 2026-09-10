// Fully self-contained, like admin-bookings.js/admin-payments.js/
// admin-agents.js — does not import anything from js/api/api.js, so
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

function adminFetchReports(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();
  return adminRequest(`/admin/reports${query ? '?' + query : ''}`, { password });
}

function adminFetchReport(id, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(id)}`, { password });
}

function adminFetchReportHistory(id, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(id)}/history`, { password });
}

function adminUpdateReportStatus(id, status, reason, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    password,
    body: { status, reason: reason || undefined }
  });
}

function adminUpdateReportNote(id, internalNote, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(id)}/note`, {
    method: 'PATCH',
    password,
    body: { internalNote }
  });
}

function adminUpdateReportSummary(id, payload, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(id)}/summary`, {
    method: 'PATCH',
    password,
    body: payload
  });
}

function adminExportReportsCsv(params, password) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const query = qs.toString();

  return fetch(`${API_BASE_URL}/admin/reports/export.csv${query ? '?' + query : ''}`, {
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

function adminFetchReportSections(reportId, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(reportId)}/sections`, { password });
}

function adminUpdateReportSection(sectionId, payload, password) {
  return adminRequest(`/admin/report-sections/${encodeURIComponent(sectionId)}`, {
    method: 'PATCH',
    password,
    body: payload
  });
}

function adminReorderReportSections(reportId, orderedIds, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(reportId)}/sections/reorder`, {
    method: 'PATCH',
    password,
    body: { orderedIds }
  });
}

function adminResetReportSections(reportId, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(reportId)}/sections/reset-defaults`, {
    method: 'POST',
    password
  });
}

function adminFetchReportPreview(reportId, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(reportId)}/preview`, { password });
}

function adminRunAiAgent(agentName, reportId, password) {
  return adminRequest('/admin/ai/run', {
    method: 'POST',
    password,
    // input deliberately omitted — the backend auto-gathers the
    // report's own context (see backend/ai/reportContext.js) when
    // entityType is "report" and no input is supplied.
    body: { agentName, entityType: 'report', entityId: reportId }
  });
}

function adminReviewAiRunResult(runId, approved, reviewNote, password) {
  return adminRequest(`/admin/ai/runs/${encodeURIComponent(runId)}/review`, {
    method: 'PATCH',
    password,
    body: { approved, reviewNote }
  });
}

function adminApplyAiRunResult(runId, password) {
  return adminRequest(`/admin/ai/runs/${encodeURIComponent(runId)}/apply`, { method: 'POST', password });
}

function adminGeneratePublicToken(reportId, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(reportId)}/public-token`, { method: 'POST', password });
}

function adminRevokePublicToken(reportId, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(reportId)}/public-token`, { method: 'DELETE', password });
}

function adminSendToCustomer(reportId, password) {
  return adminRequest(`/admin/reports/${encodeURIComponent(reportId)}/send-to-customer`, { method: 'POST', password });
}

// ---------------------------------------------------------------------------
// Page logic
// ---------------------------------------------------------------------------

const els = {};
let currentReports = [];
let currentSections = [];
let currentPublicLink = null;
let currentAiRun = null;
let activeReportId = null;
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
  reportType: 'Typ reportu',
  entityType: 'Typ entity',
  entityId: 'ID entity',
  status: 'Stav',
  language: 'Jazyk',
  customerEmail: 'E-mail zákazníka',
  draftReadyAt: 'Draft připraven',
  reportReadyAt: 'Report připraven',
  sentAt: 'Odesláno',
  completedAt: 'Dokončeno',
  cancelledAt: 'Zrušeno'
};

async function loadReports() {
  const password = getPassword();
  if (!password) {
    setListStatus('Zadejte admin heslo.', true);
    return;
  }

  sessionStorage.setItem(SESSION_KEY, password);
  setListStatus('Načítám…', false);

  const params = {
    status: els.filterStatus.value,
    reportType: els.filterReportType.value,
    entityType: els.filterEntityType.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const res = await adminFetchReports(params, password);
    currentReports = res.items || [];
    renderTable(currentReports);
    setListStatus(`Načteno ${res.items.length} z ${res.total} reportů.`, false);
    setAuthNote('Přihlášen.', false);
  } catch (err) {
    currentReports = [];
    renderTable([]);
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      setListStatus('Neplatné admin heslo.', true);
      setAuthNote('Neplatné heslo — zkuste to znovu.', true);
    } else {
      setListStatus(`Nepodařilo se načíst reporty: ${err.message}`, true);
      setAuthNote('Backend nedostupný? Zkontrolujte, že běží na portu 3001.', true);
    }
  }
}

function renderTable(reports) {
  els.tbody.innerHTML = '';
  els.emptyState.style.display = reports.length === 0 ? 'block' : 'none';

  for (const report of reports) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(report.createdAt)}</td>
      <td><span class="type-badge">${escapeHtml(field(report.reportType))}</span></td>
      <td>${escapeHtml(field(report.entityType))} <code>${escapeHtml(field(report.entityId))}</code></td>
      <td><span class="status-badge status-${escapeHtml(report.status)}">${escapeHtml(report.status)}</span></td>
      <td>${report.riskLevel ? `<span class="risk-badge risk-${escapeHtml(report.riskLevel)}">${escapeHtml(report.riskLevel)}</span>` : '—'}</td>
      <td>${escapeHtml(field(report.score))}</td>
      <td>${escapeHtml(field(report.customerEmail))}</td>
      <td>${report.publicTokenPreview ? `<code>${escapeHtml(report.publicTokenPreview)}</code>` : '—'}</td>
      <td class="admin-col-actions"><button type="button" class="btn btn-ghost on-paper btn-sm" data-id="${escapeHtml(report.id)}">Detail</button></td>
    `;
    els.tbody.appendChild(tr);
  }

  els.tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-id')));
  });
}

function renderDetail(report) {
  els.detailFields.innerHTML = Object.entries(DETAIL_FIELD_LABELS)
    .filter(([key]) => report[key] !== undefined && report[key] !== '')
    .map(([key, label]) => `
      <div><span class="k">${escapeHtml(label)}</span><span class="v">${key.endsWith('At') ? formatDate(report[key]) : escapeHtml(report[key])}</span></div>
    `).join('');

  els.detailStatus.value = report.status || 'created';
  els.detailStatusReason.value = '';
  els.detailTitle.value = report.title || '';
  els.detailSummary.value = report.summary || '';
  els.detailVerdict.value = report.verdict || '';
  els.detailRiskLevel.value = report.riskLevel || '';
  els.detailScore.value = report.score !== null && report.score !== undefined ? report.score : '';
  els.detailNote.value = report.internalNote || '';
  els.detailAiHistoryLink.href = `admin-ai-runs.html?entityType=report&entityId=${encodeURIComponent(report.id)}`;

  // Delivery block — publicToken/publicLink only ever come from a fresh
  // GET (never cached across reports), so "Copy link" always copies the
  // link for whichever report is currently open, not a stale one.
  currentPublicLink = report.publicLink || null;
  const hasActiveLink = !!report.publicToken && !report.publicTokenRevokedAt;
  els.detailTokenPreview.textContent = report.publicToken
    ? `${report.publicToken.slice(0, 8)}…${report.publicTokenRevokedAt ? ' (zrušeno)' : ''}`
    : '— zatím nevygenerováno —';
  els.detailSentAtView.textContent = report.sentAt ? formatDate(report.sentAt) : '—';
  els.detailDeliveredAtView.textContent = report.deliveredAt ? formatDate(report.deliveredAt) : '—';
  els.detailCopyLinkBtn.disabled = !hasActiveLink;
  els.detailRevokeLinkBtn.disabled = !hasActiveLink;
}

function renderHistory(historyItems) {
  if (!historyItems || historyItems.length === 0) {
    els.detailHistory.innerHTML = '<p style="margin:0;color:var(--text-muted-dark);">Zatím žádná historie.</p>';
    return;
  }
  els.detailHistory.innerHTML = historyItems
    .map((h) => `
      <div style="padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
        <span class="v">${formatDate(h.createdAt)}</span> —
        ${escapeHtml(h.oldStatus || '(nový)')} → <strong>${escapeHtml(h.newStatus)}</strong>
        ${h.reason ? `<br><span style="color:var(--text-muted-dark);font-size:0.85rem;">${escapeHtml(h.reason)}</span>` : ''}
      </div>
    `).join('');
}

function switchTab(tabName) {
  els.tabButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName));
  els.tabPanels.forEach((panel) => panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === tabName));
}

function str2(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function renderSections(sections) {
  if (!sections || sections.length === 0) {
    els.detailSectionsList.innerHTML = '<p style="margin:0;color:var(--text-muted-dark);">Tento report zatím nemá žádné sekce.</p>';
    return;
  }

  els.detailSectionsList.innerHTML = sections.map((section, index) => `
    <div class="report-section-card" data-section-id="${escapeHtml(section.id)}">
      <div class="report-section-head">
        <span class="report-section-key">${escapeHtml(section.sectionKey)}</span>
        <div style="display:flex;gap:4px;">
          <button type="button" class="btn btn-ghost on-paper btn-sm" data-move="up" data-section-id="${escapeHtml(section.id)}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn-ghost on-paper btn-sm" data-move="down" data-section-id="${escapeHtml(section.id)}" ${index === sections.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
      </div>
      <div class="modal-field" style="margin-bottom:8px;">
        <input type="text" class="report-section-title" value="${escapeHtml(section.title)}" placeholder="Titulek sekce">
      </div>
      <div class="modal-field" style="margin-bottom:8px;">
        <textarea class="report-section-content" rows="4" placeholder="Obsah zatím nevyplněn…">${escapeHtml(section.content || '')}</textarea>
      </div>
      <button type="button" class="btn btn-brass btn-sm" data-save-section="${escapeHtml(section.id)}">Uložit sekci</button>
      <span class="report-section-save-status" data-status-for="${escapeHtml(section.id)}" style="margin-left:8px;font-size:0.82rem;"></span>
    </div>
  `).join('');

  els.detailSectionsList.querySelectorAll('[data-save-section]').forEach((btn) => {
    btn.addEventListener('click', () => saveSection(btn.getAttribute('data-save-section')));
  });
  els.detailSectionsList.querySelectorAll('[data-move]').forEach((btn) => {
    btn.addEventListener('click', () => moveSection(btn.getAttribute('data-section-id'), btn.getAttribute('data-move')));
  });
}

function renderPreview(report, sections) {
  const reportTypeLabels = { vin_basic_report: 'VIN Basic Report', manual_car_review: 'Manual Car Review', inspection_report: 'Inspection Report' };
  const emptySections = (sections || []).filter((s) => !str2(s.content));

  const metaParts = [
    `Report ID: ${report.id}`,
    `Datum: ${formatDate(report.createdAt)}`,
    `Typ: ${reportTypeLabels[report.reportType] || report.reportType}`,
    `Entita: ${report.entityType} ${report.entityId}`
  ];
  if (report.score !== null && report.score !== undefined) metaParts.push(`Skóre: ${report.score}`);
  if (report.riskLevel) metaParts.push(`Riziko: ${report.riskLevel}`);
  if (report.verdict) metaParts.push(`Verdikt: ${report.verdict}`);

  const disclaimerSection = (sections || []).find((s) => s.sectionKey === 'disclaimer');
  const bodySections = (sections || []).filter((s) => s.sectionKey !== 'disclaimer');

  els.detailPreview.innerHTML = `
    <h2>NEXIUM — ${escapeHtml(report.title || reportTypeLabels[report.reportType] || 'Report')}</h2>
    <div class="report-preview-meta">${metaParts.map(escapeHtml).join(' · ')}</div>
    ${report.summary ? `<section><h3>Shrnutí</h3><p>${escapeHtml(report.summary)}</p></section>` : ''}
    ${bodySections.map((s) => `
      <section>
        <h3>${escapeHtml(s.title)}</h3>
        ${str2(s.content) ? `<p>${escapeHtml(s.content)}</p>` : '<p class="report-preview-empty">Zatím nevyplněno.</p>'}
      </section>
    `).join('')}
    ${disclaimerSection ? `<div class="report-preview-disclaimer">${escapeHtml(disclaimerSection.title)}: ${str2(disclaimerSection.content) ? escapeHtml(disclaimerSection.content) : '(nevyplněno)'}</div>` : ''}
  `;

  if (emptySections.length > 0) {
    els.detailPreview.innerHTML += `<p style="margin-top:14px;font-size:0.82rem;color:var(--brick);">⚠ ${emptySections.length} sekcí zatím nevyplněno: ${emptySections.map((s) => escapeHtml(s.sectionKey)).join(', ')}.</p>`;
  }
}

async function saveSection(sectionId) {
  const password = getPassword();
  const statusEl = els.detailSectionsList.querySelector(`[data-status-for="${sectionId}"]`);
  const card = els.detailSectionsList.querySelector(`[data-section-id="${sectionId}"]`);
  if (!card) return;

  const title = card.querySelector('.report-section-title').value;
  const content = card.querySelector('.report-section-content').value;

  if (!password) {
    if (statusEl) { statusEl.textContent = 'Zadejte admin heslo.'; statusEl.style.color = 'var(--brick)'; }
    return;
  }

  if (statusEl) { statusEl.textContent = 'Ukládám…'; statusEl.style.color = ''; }

  try {
    const res = await adminUpdateReportSection(sectionId, { title, content }, password);
    const idx = currentSections.findIndex((s) => s.id === sectionId);
    if (idx !== -1) currentSections[idx] = res.section;
    if (statusEl) { statusEl.textContent = 'Uloženo.'; statusEl.style.color = ''; }
    // Section content feeds directly into the preview and into the
    // draft_ready/report_ready validation — keep both in sync immediately
    // rather than waiting for the next full reopen.
    renderPreview(currentReports.find((r) => r.id === activeReportId), currentSections);
  } catch (err) {
    if (statusEl) { statusEl.textContent = `Chyba: ${err.message}`; statusEl.style.color = 'var(--brick)'; }
  }
}

async function moveSection(sectionId, direction) {
  const password = getPassword();
  if (!password || !activeReportId) return;

  const idx = currentSections.findIndex((s) => s.id === sectionId);
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapWith < 0 || swapWith >= currentSections.length) return;

  const reordered = currentSections.slice();
  [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];
  const orderedIds = reordered.map((s) => s.id);

  els.detailSectionsMsg.textContent = 'Ukládám pořadí…';
  els.detailSectionsMsg.classList.remove('error');

  try {
    const res = await adminReorderReportSections(activeReportId, orderedIds, password);
    currentSections = res.items;
    renderSections(currentSections);
    renderPreview(currentReports.find((r) => r.id === activeReportId), currentSections);
    els.detailSectionsMsg.textContent = 'Pořadí uloženo.';
  } catch (err) {
    els.detailSectionsMsg.textContent = `Nepodařilo se změnit pořadí: ${err.message}`;
    els.detailSectionsMsg.classList.add('error');
  }
}

async function resetSections() {
  if (!activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.detailSectionsMsg.textContent = 'Zadejte admin heslo.';
    els.detailSectionsMsg.classList.add('error');
    return;
  }
  if (!confirm('Opravdu obnovit výchozí sekce? Veškerý dosud napsaný obsah se nenávratně ztratí.')) return;

  els.detailSectionsMsg.textContent = 'Obnovuji…';
  els.detailSectionsMsg.classList.remove('error');

  try {
    const res = await adminResetReportSections(activeReportId, password);
    currentSections = res.items;
    renderSections(currentSections);
    renderPreview(currentReports.find((r) => r.id === activeReportId), currentSections);
    els.detailSectionsMsg.textContent = 'Výchozí sekce obnoveny.';
  } catch (err) {
    els.detailSectionsMsg.textContent = `Nepodařilo se obnovit: ${err.message}`;
    els.detailSectionsMsg.classList.add('error');
  }
}

async function generateLink() {
  if (!activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.detailDeliveryMsg.textContent = 'Zadejte admin heslo.';
    els.detailDeliveryMsg.classList.add('error');
    return;
  }

  els.detailDeliveryMsg.textContent = 'Generuji…';
  els.detailDeliveryMsg.classList.remove('error');

  try {
    const res = await adminGeneratePublicToken(activeReportId, password);
    currentPublicLink = res.publicLink;
    renderDetail({ ...res.report, publicLink: res.publicLink });
    const idx = currentReports.findIndex((r) => r.id === activeReportId);
    if (idx !== -1) {
      currentReports[idx] = { ...currentReports[idx], publicTokenPreview: `${res.report.publicToken.slice(0, 8)}…` };
      renderTable(currentReports);
    }
    els.detailDeliveryMsg.textContent = 'Odkaz vygenerován.';
  } catch (err) {
    els.detailDeliveryMsg.textContent = `Nepodařilo se vygenerovat odkaz: ${err.message}`;
    els.detailDeliveryMsg.classList.add('error');
  }
}

async function copyLink() {
  if (!currentPublicLink) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(currentPublicLink);
    } else {
      // Fallback for environments without the async Clipboard API.
      const textarea = document.createElement('textarea');
      textarea.value = currentPublicLink;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    els.detailDeliveryMsg.textContent = 'Odkaz zkopírován do schránky.';
    els.detailDeliveryMsg.classList.remove('error');
  } catch (err) {
    els.detailDeliveryMsg.textContent = `Nepodařilo se zkopírovat: ${err.message}`;
    els.detailDeliveryMsg.classList.add('error');
  }
}

async function revokeLink() {
  if (!activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.detailDeliveryMsg.textContent = 'Zadejte admin heslo.';
    els.detailDeliveryMsg.classList.add('error');
    return;
  }
  if (!confirm('Opravdu zrušit tento veřejný odkaz? Zákazník, který ho už má, k reportu ztratí přístup.')) return;

  els.detailDeliveryMsg.textContent = 'Ruším…';
  els.detailDeliveryMsg.classList.remove('error');

  try {
    const res = await adminRevokePublicToken(activeReportId, password);
    currentPublicLink = null;
    renderDetail({ ...res.report, publicLink: null });
    const idx = currentReports.findIndex((r) => r.id === activeReportId);
    if (idx !== -1) {
      currentReports[idx] = { ...currentReports[idx], publicTokenPreview: res.report.publicToken ? `${res.report.publicToken.slice(0, 8)}…` : null };
      renderTable(currentReports);
    }
    els.detailDeliveryMsg.textContent = 'Odkaz zrušen.';
  } catch (err) {
    els.detailDeliveryMsg.textContent = `Nepodařilo se zrušit odkaz: ${err.message}`;
    els.detailDeliveryMsg.classList.add('error');
  }
}

async function sendToCustomer() {
  if (!activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.detailDeliveryMsg.textContent = 'Zadejte admin heslo.';
    els.detailDeliveryMsg.classList.add('error');
    return;
  }

  els.detailSendToCustomerBtn.disabled = true;
  els.detailDeliveryMsg.textContent = 'Odesílám…';
  els.detailDeliveryMsg.classList.remove('error');

  try {
    const res = await adminSendToCustomer(activeReportId, password);
    currentPublicLink = res.publicLink;
    renderDetail({ ...res.report, publicLink: res.publicLink });
    const idx = currentReports.findIndex((r) => r.id === activeReportId);
    if (idx !== -1) {
      currentReports[idx] = { ...res.report, publicTokenPreview: res.report.publicToken ? `${res.report.publicToken.slice(0, 8)}…` : null };
      renderTable(currentReports);
    }
    els.detailDeliveryMsg.textContent = res.message;
    els.detailDeliveryMsg.classList.toggle('error', !res.emailSent);
  } catch (err) {
    els.detailDeliveryMsg.textContent = `Nepodařilo se odeslat: ${err.message}`;
    els.detailDeliveryMsg.classList.add('error');
  } finally {
    els.detailSendToCustomerBtn.disabled = false;
  }
}

function renderAiRunOutput(run) {
  currentAiRun = run;
  els.aiRunResultPanel.style.display = 'block';

  let pretty = run.outputJson;
  try {
    pretty = JSON.stringify(JSON.parse(run.outputJson), null, 2);
  } catch {
    // leave as-is if it's not parseable (e.g. a failed run's errorMessage case)
  }
  els.aiRunOutput.textContent = run.status === 'failed'
    ? `Run failed: ${run.errorMessage || '(no error message)'}`
    : pretty;

  els.aiReviewNote.value = run.reviewNote || '';

  const rs = run.approvedAt ? 'approved' : run.rejectedAt ? 'rejected' : 'pending review';
  els.aiReviewStateLabel.textContent = `Review: ${rs}${run.appliedAt ? ' · applied' : ''}`;
  els.aiApproveBtn.disabled = !!run.approvedAt || run.status !== 'completed';
  els.aiRejectBtn.disabled = !!run.rejectedAt || run.status !== 'completed';
  els.aiApplyBtn.disabled = !run.approvedAt;
}

async function runAiAgent() {
  if (!activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.aiRunMsg.textContent = 'Zadejte admin heslo.';
    els.aiRunMsg.classList.add('error');
    return;
  }

  const agentName = els.aiAgentSelect.value;
  els.aiRunBtn.disabled = true;
  els.aiRunMsg.textContent = 'Spouštím agenta (mock provider)…';
  els.aiRunMsg.classList.remove('error');
  els.aiRunResultPanel.style.display = 'none';

  try {
    const res = await adminRunAiAgent(agentName, activeReportId, password);
    renderAiRunOutput(res.run);
    els.aiRunMsg.textContent = 'Hotovo — výstup níže vyžaduje review před použitím.';
  } catch (err) {
    els.aiRunMsg.textContent = `Nepodařilo se spustit agenta: ${err.message}`;
    els.aiRunMsg.classList.add('error');
  } finally {
    els.aiRunBtn.disabled = false;
  }
}

async function reviewAiRunAction(approved) {
  if (!currentAiRun) return;
  const password = getPassword();
  if (!password) {
    els.aiReviewMsg.textContent = 'Zadejte admin heslo.';
    els.aiReviewMsg.classList.add('error');
    return;
  }

  els.aiReviewMsg.textContent = 'Ukládám…';
  els.aiReviewMsg.classList.remove('error');

  try {
    const res = await adminReviewAiRunResult(currentAiRun.id, approved, els.aiReviewNote.value, password);
    renderAiRunOutput(res.run);
    els.aiReviewMsg.textContent = approved ? 'Schváleno — teď lze použít „Apply to report".' : 'Zamítnuto.';
  } catch (err) {
    els.aiReviewMsg.textContent = `Nepodařilo se uložit review: ${err.message}`;
    els.aiReviewMsg.classList.add('error');
  }
}

async function applyAiRunAction() {
  if (!currentAiRun || !activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.aiReviewMsg.textContent = 'Zadejte admin heslo.';
    els.aiReviewMsg.classList.add('error');
    return;
  }

  els.aiApplyBtn.disabled = true;
  els.aiReviewMsg.textContent = 'Aplikuji do reportu…';
  els.aiReviewMsg.classList.remove('error');

  try {
    const res = await adminApplyAiRunResult(currentAiRun.id, password);
    renderAiRunOutput(res.run);

    const summaryText = (res.results || [])
      .map((r) => (r.applied ? `✓ ${r.sectionKey}` : `— ${r.sectionKey} (${r.reason || 'skipped'})`))
      .join('; ');
    els.aiReviewMsg.textContent = `Aplikováno: ${summaryText}`;

    // Refresh everything the apply could have touched: sections,
    // preview, and the report-level fields shown in Summary (score/
    // riskLevel/summary/verdict) — re-fetch fresh from the server
    // rather than guessing which fields changed client-side.
    const [reportRes, sectionsRes] = await Promise.all([
      adminFetchReport(activeReportId, password),
      adminFetchReportSections(activeReportId, password)
    ]);
    const idx = currentReports.findIndex((r) => r.id === activeReportId);
    if (idx !== -1) currentReports[idx] = reportRes.item;
    renderDetail(reportRes.item);
    currentSections = sectionsRes.items;
    renderSections(currentSections);
    renderPreview(reportRes.item, currentSections);
    renderTable(currentReports);
  } catch (err) {
    els.aiReviewMsg.textContent = `Nepodařilo se aplikovat: ${err.message}`;
    els.aiReviewMsg.classList.add('error');
  } finally {
    els.aiApplyBtn.disabled = !currentAiRun || !currentAiRun.approvedAt;
  }
}

async function openDetail(id) {
  const cachedReport = currentReports.find((r) => r.id === id);
  if (!cachedReport) return;

  activeReportId = id;
  els.detailStatusMsg.textContent = '';
  els.detailStatusMsg.classList.remove('error');
  els.detailSummaryMsg.textContent = '';
  els.detailSummaryMsg.classList.remove('error');
  els.detailNoteMsg.textContent = '';
  els.detailNoteMsg.classList.remove('error');
  els.detailSectionsMsg.textContent = '';
  els.detailSectionsMsg.classList.remove('error');
  els.detailDeliveryMsg.textContent = '';
  els.detailDeliveryMsg.classList.remove('error');
  currentAiRun = null;
  els.aiRunResultPanel.style.display = 'none';
  els.aiRunMsg.textContent = '';
  els.aiRunMsg.classList.remove('error');
  els.aiReviewMsg.textContent = '';
  els.aiReviewMsg.classList.remove('error');

  // Render immediately from whatever the list already has, so the modal
  // isn't empty while the fresh fetch below is in flight.
  renderDetail(cachedReport);
  switchTab('summary');
  els.detailHistory.innerHTML = '<p style="margin:0;color:var(--text-muted-dark);">Načítám…</p>';
  els.detailSectionsList.innerHTML = '<p style="margin:0;color:var(--text-muted-dark);">Načítám…</p>';
  els.detailOverlay.classList.add('open');

  const password = getPassword();
  if (!password) return;

  try {
    const [reportRes, historyRes, sectionsRes] = await Promise.all([
      adminFetchReport(id, password),
      adminFetchReportHistory(id, password),
      adminFetchReportSections(id, password)
    ]);
    const fresh = reportRes.item;
    const idx = currentReports.findIndex((r) => r.id === id);
    if (idx !== -1) currentReports[idx] = fresh;
    if (activeReportId === id) {
      renderDetail(fresh);
      renderHistory(historyRes.items);
      currentSections = sectionsRes.items;
      renderSections(currentSections);
      renderPreview(fresh, currentSections);
    }
  } catch (err) {
    if (activeReportId === id) {
      els.detailStatusMsg.textContent = `Nepodařilo se načíst aktuální data: ${err.message}`;
      els.detailStatusMsg.classList.add('error');
      els.detailHistory.innerHTML = '';
      els.detailSectionsList.innerHTML = '';
    }
  }
}

function closeDetail() {
  els.detailOverlay.classList.remove('open');
  activeReportId = null;
}

async function saveStatus() {
  if (!activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.detailStatusMsg.textContent = 'Zadejte admin heslo.';
    els.detailStatusMsg.classList.add('error');
    return;
  }

  const status = els.detailStatus.value;
  const reason = els.detailStatusReason.value.trim();

  els.detailStatusSave.disabled = true;
  els.detailStatusMsg.textContent = 'Ukládám…';
  els.detailStatusMsg.classList.remove('error');

  try {
    const res = await adminUpdateReportStatus(activeReportId, status, reason, password);
    const idx = currentReports.findIndex((r) => r.id === activeReportId);
    if (idx !== -1) {
      currentReports[idx] = res.report;
      renderTable(currentReports);
    }
    const historyRes = await adminFetchReportHistory(activeReportId, password);
    renderHistory(historyRes.items);
    els.detailStatusMsg.textContent = 'Uloženo.';
  } catch (err) {
    els.detailStatusMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailStatusMsg.classList.add('error');
  } finally {
    els.detailStatusSave.disabled = false;
  }
}

async function saveSummary() {
  if (!activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.detailSummaryMsg.textContent = 'Zadejte admin heslo.';
    els.detailSummaryMsg.classList.add('error');
    return;
  }

  const scoreRaw = els.detailScore.value.trim();
  const payload = {
    title: els.detailTitle.value,
    summary: els.detailSummary.value,
    verdict: els.detailVerdict.value,
    riskLevel: els.detailRiskLevel.value || null,
    score: scoreRaw === '' ? null : parseInt(scoreRaw, 10)
  };

  els.detailSummarySave.disabled = true;
  els.detailSummaryMsg.textContent = 'Ukládám…';
  els.detailSummaryMsg.classList.remove('error');

  try {
    const res = await adminUpdateReportSummary(activeReportId, payload, password);
    const idx = currentReports.findIndex((r) => r.id === activeReportId);
    if (idx !== -1) {
      currentReports[idx] = res.report;
      renderTable(currentReports);
    }
    els.detailSummaryMsg.textContent = 'Uloženo.';
  } catch (err) {
    els.detailSummaryMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailSummaryMsg.classList.add('error');
  } finally {
    els.detailSummarySave.disabled = false;
  }
}

async function saveNote() {
  if (!activeReportId) return;
  const password = getPassword();
  if (!password) {
    els.detailNoteMsg.textContent = 'Zadejte admin heslo.';
    els.detailNoteMsg.classList.add('error');
    return;
  }

  const internalNote = els.detailNote.value;

  els.detailNoteSave.disabled = true;
  els.detailNoteMsg.textContent = 'Ukládám…';
  els.detailNoteMsg.classList.remove('error');

  try {
    const res = await adminUpdateReportNote(activeReportId, internalNote, password);
    const idx = currentReports.findIndex((r) => r.id === activeReportId);
    if (idx !== -1) currentReports[idx] = res.report;
    els.detailNoteMsg.textContent = 'Uloženo.';
  } catch (err) {
    els.detailNoteMsg.textContent = `Nepodařilo se uložit: ${err.message}`;
    els.detailNoteMsg.classList.add('error');
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

  const params = {
    status: els.filterStatus.value,
    reportType: els.filterReportType.value,
    entityType: els.filterEntityType.value,
    search: els.filterSearch.value.trim()
  };

  try {
    const blob = await adminExportReportsCsv(params, password);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reports-${new Date().toISOString().slice(0, 10)}.csv`;
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
  els.filterReportType = $('filterReportType');
  els.filterEntityType = $('filterEntityType');
  els.filterSearch = $('filterSearch');
  els.refreshBtn = $('refreshBtn');
  els.exportBtn = $('exportBtn');
  els.listStatus = $('listStatus');
  els.tbody = $('reportsTbody');
  els.emptyState = $('emptyState');

  els.detailOverlay = $('detailOverlay');
  els.detailClose = $('detailClose');
  els.detailCloseBtn2 = $('detailCloseBtn2');
  els.detailFields = $('detailFields');

  els.detailStatus = $('detailStatus');
  els.detailStatusReason = $('detailStatusReason');
  els.detailStatusSave = $('detailStatusSave');
  els.detailStatusMsg = $('detailStatusMsg');

  els.detailTitle = $('detailTitle');
  els.detailSummary = $('detailSummary');
  els.detailVerdict = $('detailVerdict');
  els.detailRiskLevel = $('detailRiskLevel');
  els.detailScore = $('detailScore');
  els.detailSummarySave = $('detailSummarySave');
  els.detailSummaryMsg = $('detailSummaryMsg');

  els.detailNote = $('detailNote');
  els.detailNoteSave = $('detailNoteSave');
  els.detailNoteMsg = $('detailNoteMsg');

  els.detailHistory = $('detailHistory');

  els.tabButtons = Array.from(document.querySelectorAll('.admin-tab-btn'));
  els.tabPanels = Array.from(document.querySelectorAll('.admin-tab-panel'));
  els.detailSectionsList = $('detailSectionsList');
  els.detailSectionsMsg = $('detailSectionsMsg');
  els.detailResetSectionsBtn = $('detailResetSectionsBtn');
  els.detailPreview = $('detailPreview');

  els.detailTokenPreview = $('detailTokenPreview');
  els.detailSentAtView = $('detailSentAtView');
  els.detailDeliveredAtView = $('detailDeliveredAtView');
  els.detailGenerateLinkBtn = $('detailGenerateLinkBtn');
  els.detailCopyLinkBtn = $('detailCopyLinkBtn');
  els.detailRevokeLinkBtn = $('detailRevokeLinkBtn');
  els.detailSendToCustomerBtn = $('detailSendToCustomerBtn');
  els.detailDeliveryMsg = $('detailDeliveryMsg');

  els.aiAgentSelect = $('aiAgentSelect');
  els.aiRunBtn = $('aiRunBtn');
  els.aiRunMsg = $('aiRunMsg');
  els.aiRunResultPanel = $('aiRunResultPanel');
  els.aiRunOutput = $('aiRunOutput');
  els.aiReviewNote = $('aiReviewNote');
  els.aiApproveBtn = $('aiApproveBtn');
  els.aiRejectBtn = $('aiRejectBtn');
  els.aiApplyBtn = $('aiApplyBtn');
  els.aiReviewStateLabel = $('aiReviewStateLabel');
  els.aiReviewMsg = $('aiReviewMsg');
  els.detailAiHistoryLink = $('detailAiHistoryLink');

  const savedPassword = sessionStorage.getItem(SESSION_KEY);
  if (savedPassword) {
    els.passwordInput.value = savedPassword;
  }

  els.loadBtn.addEventListener('click', loadReports);
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadReports();
  });

  els.refreshBtn.addEventListener('click', loadReports);
  els.exportBtn.addEventListener('click', exportCsv);
  els.filterStatus.addEventListener('change', loadReports);
  els.filterReportType.addEventListener('change', loadReports);
  els.filterEntityType.addEventListener('change', loadReports);
  els.filterSearch.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(loadReports, 350);
  });

  els.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });
  els.detailResetSectionsBtn.addEventListener('click', resetSections);
  els.detailGenerateLinkBtn.addEventListener('click', generateLink);
  els.detailCopyLinkBtn.addEventListener('click', copyLink);
  els.detailRevokeLinkBtn.addEventListener('click', revokeLink);
  els.detailSendToCustomerBtn.addEventListener('click', sendToCustomer);
  els.aiRunBtn.addEventListener('click', runAiAgent);
  els.aiApproveBtn.addEventListener('click', () => reviewAiRunAction(true));
  els.aiRejectBtn.addEventListener('click', () => reviewAiRunAction(false));
  els.aiApplyBtn.addEventListener('click', applyAiRunAction);

  els.detailClose.addEventListener('click', closeDetail);
  els.detailCloseBtn2.addEventListener('click', closeDetail);
  els.detailStatusSave.addEventListener('click', saveStatus);
  els.detailSummarySave.addEventListener('click', saveSummary);
  els.detailNoteSave.addEventListener('click', saveNote);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.detailOverlay.classList.contains('open')) closeDetail();
  });

  if (savedPassword) {
    loadReports();
  }
}

document.addEventListener('DOMContentLoaded', init);

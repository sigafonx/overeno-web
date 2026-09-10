// Public report page — no admin password, no session, nothing admin-only.
// The only "credential" here is the token itself, read straight from the
// URL. This file never touches sessionStorage/localStorage and never
// calls any /admin/* endpoint — it only ever talks to the one public,
// unauthenticated GET /reports/public/:token.

const API_BASE_URL = (window.OVERENO_CONFIG && window.OVERENO_CONFIG.apiBaseUrl) || 'http://localhost:3001';

const REPORT_TYPE_LABELS = {
  vin_basic_report: 'VIN Basic Report',
  manual_car_review: 'Manual Car Review',
  inspection_report: 'Inspection Report'
};

const RISK_LABELS = { low: 'Nízké riziko', medium: 'Střední riziko', high: 'Vysoké riziko' };

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value === undefined || value === null ? '' : String(value);
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function setState(html, isError) {
  const stateEl = document.getElementById('state');
  const docEl = document.getElementById('reportDoc');
  stateEl.style.display = 'block';
  stateEl.innerHTML = html;
  stateEl.classList.toggle('error-state', !!isError);
  docEl.style.display = 'none';
}

function renderReport(report, sections) {
  const stateEl = document.getElementById('state');
  const docEl = document.getElementById('reportDoc');
  stateEl.style.display = 'none';
  docEl.style.display = 'block';

  const badges = [];
  if (report.riskLevel) {
    badges.push(`<span class="report-doc-badge badge-risk-${escapeHtml(report.riskLevel)}">${escapeHtml(RISK_LABELS[report.riskLevel] || report.riskLevel)}</span>`);
  }
  if (report.score !== null && report.score !== undefined) {
    badges.push(`<span class="report-doc-badge badge-score">Skóre: ${escapeHtml(report.score)}/100</span>`);
  }

  const sortedSections = (sections || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const disclaimerSection = sortedSections.find((s) => s.sectionKey === 'disclaimer');
  const bodySections = sortedSections.filter((s) => s.sectionKey !== 'disclaimer' && s.content && s.content.trim());

  docEl.innerHTML = `
    <h1>${escapeHtml(report.title || REPORT_TYPE_LABELS[report.reportType] || 'Report')}</h1>
    <div class="report-doc-meta">
      NEXIUM · ${escapeHtml(REPORT_TYPE_LABELS[report.reportType] || report.reportType)} · ${escapeHtml(formatDate(report.completedAt || report.createdAt))}
    </div>
    ${badges.length > 0 ? `<div class="report-doc-badges">${badges.join('')}</div>` : ''}
    ${report.summary ? `<section><h2>Shrnutí</h2><p>${escapeHtml(report.summary)}</p></section>` : ''}
    ${report.verdict ? `<section><h2>Verdikt</h2><p>${escapeHtml(report.verdict)}</p></section>` : ''}
    ${bodySections.map((s) => `
      <section>
        <h2>${escapeHtml(s.title)}</h2>
        <p>${escapeHtml(s.content)}</p>
      </section>
    `).join('')}
    ${disclaimerSection && disclaimerSection.content && disclaimerSection.content.trim() ? `
      <div class="report-doc-disclaimer">${escapeHtml(disclaimerSection.content)}</div>
    ` : `
      <div class="report-doc-disclaimer">
        Tento report snižuje riziko koupě problémového vozidla, ale negarantuje,
        že vozidlo je bez závad. Vždy doporučujeme fyzickou prohlídku vozidla
        před koupí.
      </div>
    `}
  `;
}

async function loadReport() {
  const token = new URLSearchParams(window.location.search).get('token');

  if (!token) {
    setState('Chybí token — tento odkaz je neplatný. Zkontrolujte, že jste odkaz zkopírovali celý.', true);
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/reports/public/${encodeURIComponent(token)}`);

    if (res.status === 410) {
      setState('Tento odkaz byl zrušen a už není platný. Pokud potřebujete report znovu, kontaktujte nás.', true);
      return;
    }
    if (res.status === 404) {
      setState('Report nenalezen. Odkaz může být neplatný, nebo report ještě není připraven.', true);
      return;
    }
    if (!res.ok) {
      setState(`Nepodařilo se načíst report (chyba ${res.status}). Zkuste to prosím později.`, true);
      return;
    }

    const data = await res.json();
    renderReport(data.report, data.sections);
  } catch (err) {
    setState('Nepodařilo se spojit se serverem. Zkontrolujte připojení a zkuste to znovu.', true);
  }
}

document.addEventListener('DOMContentLoaded', loadReport);

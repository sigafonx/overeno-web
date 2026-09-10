// Public badge page — no admin password, no session, nothing admin-only.
// The only "credential" here is the badge code itself, read straight
// from the URL. This file never touches sessionStorage/localStorage and
// never calls any /admin/* endpoint — it only ever talks to the one
// public, unauthenticated GET /badges/public/:badgeCode.
//
// Always renders the badge's TRUE current status — this page has no
// concept of "probably verified" or "likely fine"; it shows exactly
// what the backend says (requested/approved/rejected/revoked/expired),
// with wording that never overstates what NEXIUM has actually
// confirmed. See backend/README.md's "Dealer workflow" section for the
// full picture of why this matters.

const API_BASE_URL = (window.OVERENO_CONFIG && window.OVERENO_CONFIG.apiBaseUrl) || 'http://localhost:3001';

const STATUS_DISPLAY = {
  approved: { label: 'NEXIUM — badge platný', cssClass: 'badge-risk-low', summary: 'Tento badge byl adminem NEXIUM schválen a je aktuálně platný.' },
  requested: { label: 'Žádost o badge podána', cssClass: 'badge-risk-medium', summary: 'Dealer o tento badge požádal, ale zatím nebyl adminem NEXIUM schválen. Tenhle stav sám o sobě nic negarantuje.' },
  rejected: { label: 'Žádost zamítnuta', cssClass: 'badge-risk-high', summary: 'Tato žádost o badge byla adminem NEXIUM zamítnuta.' },
  revoked: { label: 'Badge zrušen', cssClass: 'badge-risk-high', summary: 'Tento badge byl dodatečně zrušen a už neplatí.' },
  expired: { label: 'Platnost vypršela', cssClass: 'badge-risk-medium', summary: 'Platnost tohoto badge vypršela — pro aktuální stav kontaktujte dealera nebo NEXIUM.' }
};

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
  const docEl = document.getElementById('badgeDoc');
  stateEl.style.display = 'block';
  stateEl.innerHTML = html;
  stateEl.classList.toggle('error-state', !!isError);
  docEl.style.display = 'none';
}

function renderBadge(data) {
  const stateEl = document.getElementById('state');
  const docEl = document.getElementById('badgeDoc');
  stateEl.style.display = 'none';
  docEl.style.display = 'block';

  const display = STATUS_DISPLAY[data.badge.status] || { label: data.badge.status, cssClass: 'badge-risk-medium', summary: '' };
  const vehicleLine = data.vehicle
    ? [data.vehicle.make, data.vehicle.model, data.vehicle.year].filter(Boolean).join(' ')
    : null;

  docEl.innerHTML = `
    <h1>${data.dealer ? escapeHtml(data.dealer.companyName) : 'NEXIUM badge'}</h1>
    <div class="report-doc-meta">NEXIUM · kód badge: ${escapeHtml(data.badge.badgeCode)}</div>
    <div class="report-doc-badges">
      <span class="report-doc-badge ${display.cssClass}">${escapeHtml(display.label)}</span>
    </div>
    ${display.summary ? `<section><p>${escapeHtml(display.summary)}</p></section>` : ''}
    ${vehicleLine || data.vehicle?.vin ? `
      <section>
        <h2>Vozidlo</h2>
        <p>
          ${vehicleLine ? escapeHtml(vehicleLine) + '<br>' : ''}
          ${data.vehicle.vin ? `VIN: ${escapeHtml(data.vehicle.vin)}<br>` : ''}
          ${data.vehicle.listingUrl ? `<a href="${escapeHtml(data.vehicle.listingUrl)}" target="_blank" rel="noopener">Odkaz na inzerát ↗</a>` : ''}
        </p>
      </section>
    ` : ''}
    ${data.badge.issuedAt || data.badge.expiresAt ? `
      <section>
        <h2>Platnost</h2>
        <p>
          ${data.badge.issuedAt ? `Vydáno: ${escapeHtml(formatDate(data.badge.issuedAt))}<br>` : ''}
          ${data.badge.expiresAt ? `Platnost do: ${escapeHtml(formatDate(data.badge.expiresAt))}` : ''}
        </p>
      </section>
    ` : ''}
    <div class="report-doc-disclaimer">${escapeHtml(data.disclaimer)}</div>
  `;
}

async function loadBadge() {
  const code = new URLSearchParams(window.location.search).get('code');

  if (!code) {
    setState('Chybí kód badge — tento odkaz je neplatný. Zkontrolujte, že jste odkaz zkopírovali celý.', true);
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/badges/public/${encodeURIComponent(code)}`);

    if (res.status === 404) {
      setState('Badge nenalezen. Zkontrolujte, že je kód správně napsaný.', true);
      return;
    }
    if (!res.ok) {
      setState(`Nepodařilo se načíst badge (chyba ${res.status}). Zkuste to prosím později.`, true);
      return;
    }

    const data = await res.json();
    renderBadge(data);
  } catch {
    setState('Nepodařilo se spojit se serverem. Zkontrolujte připojení a zkuste to znovu.', true);
  }
}

document.addEventListener('DOMContentLoaded', loadBadge);

import { openDealerForm, openInspectorForm } from './PartnerFormModal.js';

export const html = `
<section class="on-paper" id="partners">
  <div class="wrap">
    <div class="section-head">
      <h2 data-i18n="partners.heading">Připojte se k síti NEXIUM</h2>
    </div>
    <div class="partners-grid">
      <div class="partner-card">
        <div class="partner-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6"/></svg>
        </div>
        <h3 data-i18n="partners.dealer_title">Jsem autobazar</h3>
        <p data-i18n="partners.dealer_desc">Získejte odznak Ověřeno u svých inzerátů a prodávejte rychleji díky důvěře kupujících.</p>
        <button type="button" class="btn btn-brass" id="dealerCtaBtn" data-i18n="partners.dealer_cta">Chci odznak Ověřeno</button>
      </div>
      <div class="partner-card">
        <div class="partner-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a4 4 0 1 1-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 1 5.4-5.4z"/></svg>
        </div>
        <h3 data-i18n="partners.inspector_title">Jsem technik / STK</h3>
        <p data-i18n="partners.inspector_desc">Přijímejte objednávky na prohlídky vozů ve svém okolí a vydělávejte navíc ve volném čase.</p>
        <button type="button" class="btn btn-ghost on-paper" id="inspectorCtaBtn" data-i18n="partners.inspector_cta">Chci se připojit jako technik</button>
      </div>
    </div>
  </div>
</section>
`;

export function init() {
  document.getElementById('dealerCtaBtn').addEventListener('click', () => openDealerForm());
  document.getElementById('inspectorCtaBtn').addEventListener('click', () => openInspectorForm());
}

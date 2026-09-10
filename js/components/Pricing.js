export const html = `
<section class="on-ink" id="pricing">
  <div class="wrap">
    <div class="section-head">
      <h2 data-i18n="pricing.heading">Ceník</h2>
      <p data-i18n="pricing.sub">Plaťte jen za to, co skutečně potřebujete.</p>
    </div>
    <div class="price-toggle" id="priceToggle">
      <button class="active" data-tab="b2c" data-i18n="pricing.toggle_b2c">Pro kupující</button>
      <button data-tab="b2b" data-i18n="pricing.toggle_b2b">Pro autobazary</button>
    </div>

    <div class="price-grid show" id="grid-b2c">
      <div class="price-card">
        <h3 data-i18n="pricing.b2c_plan1_name">Základ</h3>
        <p class="desc" data-i18n="pricing.b2c_plan1_desc">Rychlá kontrola VIN a historie</p>
        <div class="price-tag"><span class="amount" data-i18n="pricing.b2c_plan1_price">199 Kč</span><span class="period" data-i18n="pricing.b2c_plan1_period">/ kontrola</span></div>
        <ul class="price-features">
          <li><span data-i18n="pricing.b2c_plan1_f1">Historie podle VIN</span></li>
          <li><span data-i18n="pricing.b2c_plan1_f2">Kontrola najetých km</span></li>
          <li><span data-i18n="pricing.b2c_plan1_f3">Přehled pojistných událostí</span></li>
        </ul>
        <a href="#demo" class="btn btn-ghost btn-block" data-i18n="pricing.b2c_cta">Vybrat</a>
      </div>
      <div class="price-card featured">
        <span class="price-badge" data-i18n="pricing.b2c_plan2_badge">Nejoblíbenější</span>
        <h3 data-i18n="pricing.b2c_plan2_name">Premium</h3>
        <p class="desc" data-i18n="pricing.b2c_plan2_desc">AI analýza + kompletní report</p>
        <div class="price-tag"><span class="amount" data-i18n="pricing.b2c_plan2_price">590 Kč</span><span class="period" data-i18n="pricing.b2c_plan2_period">/ kontrola</span></div>
        <ul class="price-features">
          <li><span data-i18n="pricing.b2c_plan2_f1">Vše ze Základu</span></li>
          <li><span data-i18n="pricing.b2c_plan2_f2">AI kontrola fotek inzerátu</span></li>
          <li><span data-i18n="pricing.b2c_plan2_f3">Odhad rizika stočení tachometru</span></li>
          <li><span data-i18n="pricing.b2c_plan2_f4">PDF report ke stažení</span></li>
        </ul>
        <a href="#demo" class="btn btn-brass btn-block" data-i18n="pricing.b2c_cta">Vybrat</a>
      </div>
      <div class="price-card">
        <h3 data-i18n="pricing.b2c_plan3_name">Kompletní</h3>
        <p class="desc" data-i18n="pricing.b2c_plan3_desc">Fyzická prohlídka technikem</p>
        <div class="price-tag"><span class="amount" data-i18n="pricing.b2c_plan3_price">2 490 Kč</span><span class="period" data-i18n="pricing.b2c_plan3_period">/ kontrola</span></div>
        <ul class="price-features">
          <li><span data-i18n="pricing.b2c_plan3_f1">Vše z Premium</span></li>
          <li><span data-i18n="pricing.b2c_plan3_f2">Prohlídka technikem na místě</span></li>
          <li><span data-i18n="pricing.b2c_plan3_f3">Zkušební jízda a diagnostika</span></li>
          <li><span data-i18n="pricing.b2c_plan3_f4">Telefonická konzultace výsledku</span></li>
        </ul>
        <a href="#demo" class="btn btn-ghost btn-block" data-i18n="pricing.b2c_cta">Vybrat</a>
      </div>
    </div>

    <div class="price-grid" id="grid-b2b">
      <div class="price-card">
        <h3 data-i18n="pricing.b2b_plan1_name">Start</h3>
        <p class="desc" data-i18n="pricing.b2b_plan1_desc">Pro menší bazary do 15 vozů</p>
        <div class="price-tag"><span class="amount" data-i18n="pricing.b2b_plan1_price">990 Kč</span><span class="period" data-i18n="pricing.b2b_plan1_period">/ měsíc</span></div>
        <ul class="price-features">
          <li><span data-i18n="pricing.b2b_plan1_f1">Odznak Ověřeno u inzerátů</span></li>
          <li><span data-i18n="pricing.b2b_plan1_f2">Až 15 aktivních vozů</span></li>
          <li><span data-i18n="pricing.b2b_plan1_f3">Základní AI kontrola fotek</span></li>
        </ul>
        <a href="#partners" class="btn btn-ghost btn-block" data-i18n="pricing.b2b_cta">Chci tento plán</a>
      </div>
      <div class="price-card featured">
        <span class="price-badge" data-i18n="pricing.b2c_plan2_badge">Nejoblíbenější</span>
        <h3 data-i18n="pricing.b2b_plan2_name">Bazar</h3>
        <p class="desc" data-i18n="pricing.b2b_plan2_desc">Pro střední a velké bazary</p>
        <div class="price-tag"><span class="amount" data-i18n="pricing.b2b_plan2_price">2 990 Kč</span><span class="period" data-i18n="pricing.b2b_plan2_period">/ měsíc</span></div>
        <ul class="price-features">
          <li><span data-i18n="pricing.b2b_plan2_f1">Vše ze Start</span></li>
          <li><span data-i18n="pricing.b2b_plan2_f2">Neomezený počet vozů</span></li>
          <li><span data-i18n="pricing.b2b_plan2_f3">Prioritní termíny techniků</span></li>
          <li><span data-i18n="pricing.b2b_plan2_f4">Statistiky důvěryhodnosti bazaru</span></li>
        </ul>
        <a href="#partners" class="btn btn-brass btn-block" data-i18n="pricing.b2b_cta">Chci tento plán</a>
      </div>
      <div class="price-card">
        <h3 data-i18n="pricing.b2b_plan3_name">Síť</h3>
        <p class="desc" data-i18n="pricing.b2b_plan3_desc">Pro dealerské sítě a importéry</p>
        <div class="price-tag"><span class="amount" data-i18n="pricing.b2b_plan3_price">Na míru</span><span class="period" data-i18n="pricing.b2b_plan3_period"></span></div>
        <ul class="price-features">
          <li><span data-i18n="pricing.b2b_plan3_f1">Vše z Bazar</span></li>
          <li><span data-i18n="pricing.b2b_plan3_f2">Vlastní API napojení</span></li>
          <li><span data-i18n="pricing.b2b_plan3_f3">Dedikovaný account manager</span></li>
          <li><span data-i18n="pricing.b2b_plan3_f4">Hromadné reporty pro celou síť</span></li>
        </ul>
        <a href="#partners" class="btn btn-ghost btn-block" data-i18n="pricing.b2b_cta_contact">Kontaktovat obchod</a>
      </div>
    </div>
  </div>
</section>
`;

export function init() {
  const priceToggle = document.getElementById('priceToggle');
  priceToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    priceToggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    const tab = btn.getAttribute('data-tab');
    document.getElementById('grid-b2c').classList.toggle('show', tab === 'b2c');
    document.getElementById('grid-b2b').classList.toggle('show', tab === 'b2b');
  });
}

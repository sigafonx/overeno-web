export const html = `
<section class="hero on-ink" id="top">
  <div class="hero-inner">
    <div class="hero-text">
      <h1 data-i18n="hero.h1">Než zaplatíte za ojetý vůz, ať ho prověří někdo jiný než prodejce.</h1>
      <p class="hero-sub" data-i18n="hero.sub">NEXIUM spojuje kontrolu VIN, AI analýzu inzerátu a nezávislé techniky po celé ČR — takže víte, co skutečně kupujete, ještě před podpisem smlouvy.</p>
      <div class="hero-ctas">
        <a href="#demo" class="btn btn-brass" data-i18n="hero.cta1">Prověřit vozidlo zdarma</a>
        <a href="#partners" class="btn btn-ghost" data-i18n="hero.cta2">Jsem autobazar</a>
      </div>
      <div class="hero-stats">
        <div class="stat"><span class="stat-num" data-i18n="hero.stat1_num">2 380+</span><span class="stat-label" data-i18n="hero.stat1_label">prověřených vozidel</span></div>
        <div class="stat"><span class="stat-num" data-i18n="hero.stat2_num">312</span><span class="stat-label" data-i18n="hero.stat2_label">nezávislých techniků v síti</span></div>
        <div class="stat"><span class="stat-num" data-i18n="hero.stat3_num">41</span><span class="stat-label" data-i18n="hero.stat3_label">odhalených stočených tachometrů</span></div>
      </div>
    </div>
    <div class="hero-visual">
      <svg class="stamp-svg" viewBox="0 0 220 220">
        <defs>
          <path id="stampCircle" d="M 110,110 m -78,0 a 78,78 0 1,1 156,0 a 78,78 0 1,1 -156,0" />
        </defs>
        <circle cx="110" cy="110" r="98" class="stamp-outer"/>
        <circle cx="110" cy="110" r="78" class="stamp-ring"/>
        <text class="stamp-text">
          <textPath href="#stampCircle" startOffset="2%">NEXIUM • NEXIUM • NEXIUM •</textPath>
        </text>
        <path class="stamp-check" d="M66,112 L92,138 L154,76"/>
      </svg>
      <div class="vin-plate">
        <span class="vin-dot"></span>
        <span>TMBJJ7NX0K0123456</span>
      </div>
    </div>
  </div>
</section>
`;

// Purely presentational — the stamp animation is CSS-only, no JS needed.
export function init() {}

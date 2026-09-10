export const html = `
<div class="margin-rule"></div>
<header class="nav">
  <div class="nav-inner">
    <a href="#top" class="brand">NEXIUM<span class="brand-dot">•</span></a>
    <nav class="nav-links" id="navLinks">
      <a href="#how" data-i18n="nav.link_how">Jak to funguje</a>
      <a href="#pricing" data-i18n="nav.link_pricing">Ceník</a>
      <a href="#partners" data-i18n="nav.link_dealers">Pro bazary</a>
      <a href="#reviews" data-i18n="nav.link_reviews">Recenze</a>
      <a href="#faq" data-i18n="nav.link_faq">FAQ</a>
    </nav>
    <div class="nav-actions">
      <div class="lang-switch" id="langSwitch">
        <button class="lang-btn active" data-lang="cs">CS</button>
        <button class="lang-btn" data-lang="en">EN</button>
        <button class="lang-btn" data-lang="ru">RU</button>
        <button class="lang-btn" data-lang="uk">UA</button>
      </div>
      <a href="#demo" class="btn btn-brass btn-sm" data-i18n="nav.cta">Zkontrolovat vůz</a>
      <button class="menu-toggle" id="menuToggle" aria-label="Menu">&#9776;</button>
    </div>
  </div>
</header>
`;

/** Mobile nav toggle. Language switch is wired separately in js/i18n/i18n.js (initLangSwitch). */
export function init() {
  const menuToggle = document.getElementById('menuToggle');
  const navLinks = document.getElementById('navLinks');

  menuToggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });

  navLinks.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => navLinks.classList.remove('open'));
  });
}

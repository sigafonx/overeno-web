import { translations, titles } from './translations.js';

let currentLang = 'cs';

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

/** Returns the currently active language code ('cs' | 'en' | 'ru' | 'uk'). */
export function getCurrentLang() {
  return currentLang;
}

/** Looks up a translation string for the current language, e.g. translate('demo.verdict_good'). */
export function translate(key) {
  return getPath(translations[currentLang], key);
}

/**
 * Switches the whole page to the given language: updates <html lang>,
 * document.title, every [data-i18n] text node, every [data-i18n-ph]
 * placeholder, and the active state of the language switch buttons.
 */
export function applyLang(lang) {
  if (!translations[lang]) return;
  currentLang = lang;

  document.documentElement.lang = lang;
  document.title = titles[lang] || titles.cs;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const val = getPath(translations[lang], key);
    if (val !== undefined) el.textContent = val;
  });

  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph');
    const val = getPath(translations[lang], key);
    if (val !== undefined) el.setAttribute('placeholder', val);
  });

  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-lang') === lang);
  });
}

/** Wires up the language switch buttons in the Header component. Call once after Header is mounted. */
export function initLangSwitch() {
  const langSwitch = document.getElementById('langSwitch');
  if (!langSwitch) return;
  langSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.lang-btn');
    if (!btn) return;
    applyLang(btn.getAttribute('data-lang'));
  });
}

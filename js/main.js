import * as Header from './components/Header.js';
import * as Hero from './components/Hero.js';
import * as ProblemSection from './components/ProblemSection.js';
import * as HowItWorks from './components/HowItWorks.js';
import * as VinDemo from './components/VinDemo.js';
import * as Pricing from './components/Pricing.js';
import * as Partners from './components/Partners.js';
import * as Reviews from './components/Reviews.js';
import * as FAQ from './components/FAQ.js';
import * as FinalCTA from './components/FinalCTA.js';
import * as Footer from './components/Footer.js';
import * as BookingModal from './components/BookingModal.js';
import * as PartnerFormModal from './components/PartnerFormModal.js';
import { initLangSwitch } from './i18n/i18n.js';

// Order here = order on the page (except BookingModal and PartnerFormModal,
// which are overlays and can live anywhere in the DOM).
const components = [
  Header,
  Hero,
  ProblemSection,
  HowItWorks,
  VinDemo,
  Pricing,
  Partners,
  Reviews,
  FAQ,
  FinalCTA,
  Footer,
  BookingModal,
  PartnerFormModal
];

function mount() {
  const app = document.getElementById('app');

  // 1. Render all markup first...
  app.innerHTML = components.map((c) => c.html).join('\n');

  // 2. ...then wire up each component's own event listeners. This order
  //    matters: every id/class a component's init() looks for must already
  //    exist in the DOM by this point.
  components.forEach((c) => {
    if (typeof c.init === 'function') c.init();
  });

  // 3. i18n needs the #langSwitch button group from Header to already exist.
  initLangSwitch();
}

document.addEventListener('DOMContentLoaded', mount);

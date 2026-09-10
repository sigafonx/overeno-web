import { checkVin } from '../api/api.js';
import { translate } from '../i18n/i18n.js';
import { open as openBookingModal } from './BookingModal.js';

export const html = `
<section class="on-paper" id="demo">
  <div class="wrap">
    <div class="section-head">
      <h2 data-i18n="demo.heading">Vyzkoušejte kontrolu VIN</h2>
      <p data-i18n="demo.sub">Zadejte VIN kód a podívejte se, jak vypadá výstup kontroly.</p>
    </div>
    <div class="demo-panel">
      <div>
        <form class="vin-form" id="vinForm">
          <input type="text" id="vinInput" data-i18n-ph="demo.placeholder" placeholder="např. TMBJJ7NX0K0123456" maxlength="24">
          <button type="submit" class="btn btn-brass" data-i18n="demo.button">Zkontrolovat</button>
        </form>
        <p class="demo-note" data-i18n="demo.note">Toto je ukázka rozhraní s demonstračními daty, ne reálná databáze.</p>
        <p class="demo-error" id="demoError" data-i18n="demo.error">Zadejte prosím alespoň 5 znaků VIN.</p>
      </div>
      <div class="result-panel" id="resultPanel">
        <div class="gauge-wrap">
          <svg viewBox="0 0 120 120">
            <circle class="gauge-track" cx="60" cy="60" r="54"/>
            <circle class="gauge-bar" id="gaugeBar" cx="60" cy="60" r="54"/>
          </svg>
          <div class="gauge-num"><span class="n" id="gaugeScore">--</span><span class="l" data-i18n="demo.label_score">Skóre</span></div>
        </div>
        <div>
          <div class="result-title" data-i18n="demo.result_title">Výsledek kontroly</div>
          <div class="verdict" id="verdictBox">—</div>
          <div class="result-fields">
            <div class="rf"><span class="k" data-i18n="demo.label_year">Rok výroby</span><span class="v" id="rfYear">—</span></div>
            <div class="rf"><span class="k" data-i18n="demo.label_mileage">Odhad km (AI)</span><span class="v" id="rfMileage">—</span></div>
            <div class="rf"><span class="k" data-i18n="demo.label_advertised">Uvedeno v inzerátu</span><span class="v" id="rfAdvertised">—</span></div>
            <div class="rf"><span class="k" data-i18n="demo.label_accidents">Pojistné události</span><span class="v" id="rfAccidents">—</span></div>
            <div class="rf"><span class="k" data-i18n="demo.label_owners">Počet majitelů</span><span class="v" id="rfOwners">—</span></div>
            <div class="rf"><span class="k" data-i18n="demo.label_odometer">Riziko stočení</span><span class="v" id="rfOdo">—</span></div>
          </div>
          <button class="btn btn-ghost on-paper btn-sm" id="bookBtn" data-i18n="demo.book_cta">Objednat prohlídku u technika</button>
          <p class="demo-note" id="resultDisclaimer" data-i18n="demo.disclaimer_result">Toto je ukázkový výsledek — nejde o oficiální prověření historie vozidla.</p>
        </div>
      </div>
    </div>
  </div>
</section>
`;

const GAUGE_CIRCUMFERENCE = 339.3;

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function init() {
  const form = document.getElementById('vinForm');
  const errEl = document.getElementById('demoError');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const raw = document.getElementById('vinInput').value.trim();
    if (raw.length < 5) {
      errEl.textContent = translate('demo.error');
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';

    try {
      // Single call site for the VIN check. checkVin() itself decides
      // whether this hits the real POST /vin/check backend or the mock.
      const response = await checkVin(raw);
      renderResult(response);
    } catch (err) {
      // Reachable backend rejected the VIN (e.g. disallowed characters) —
      // show the message instead of leaving the form silently stuck.
      errEl.textContent = err.message || translate('partnersForm.error');
      errEl.style.display = 'block';
    }
  });

  document.getElementById('bookBtn').addEventListener('click', () => {
    const vin = document.getElementById('vinInput').value.trim();
    openBookingModal(vin);
  });
}

function renderResult(response) {
  const result = response.result;
  const resultPanel = document.getElementById('resultPanel');

  // Kept around for a future step (e.g. linking a booking back to the
  // check that led to it) — not displayed anywhere yet.
  resultPanel.dataset.checkId = response.id || '';

  document.getElementById('rfYear').textContent = result.year;
  document.getElementById('rfMileage').textContent = formatNumber(result.estimatedMileage) + ' km';
  document.getElementById('rfAdvertised').textContent = formatNumber(result.advertisedMileage) + ' km';
  document.getElementById('rfAccidents').textContent = result.accidents;
  document.getElementById('rfOwners').textContent = result.owners;
  document.getElementById('rfOdo').textContent = translate('demo.odo_' + result.odometerRisk);

  const gaugeBar = document.getElementById('gaugeBar');
  gaugeBar.style.strokeDashoffset = GAUGE_CIRCUMFERENCE * (1 - result.score / 100);
  document.getElementById('gaugeScore').textContent = result.score;

  const verdictSuffix = result.verdictKey.replace('verdict_', '');
  const verdictBox = document.getElementById('verdictBox');
  verdictBox.classList.remove('good', 'warn', 'bad');
  verdictBox.classList.add(verdictSuffix);
  verdictBox.textContent = translate('demo.' + result.verdictKey);

  gaugeBar.style.stroke =
    verdictSuffix === 'good' ? 'var(--olive)' :
    verdictSuffix === 'warn' ? 'var(--brass)' : 'var(--brick)';

  resultPanel.classList.add('show');
}

import { submitLead } from '../api/api.js';
import { translate, getCurrentLang } from '../i18n/i18n.js';

export const html = `
<div class="modal-overlay" id="partnerModalOverlay">
  <div class="modal-box">
    <button class="modal-close" id="partnerModalClose">&times;</button>

    <div id="dealerFormWrap">
      <h3 data-i18n="partnersForm.dealer_title">Poptávka pro autobazar</h3>
      <form id="dealerForm" novalidate>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_companyName">Název autobazaru</label>
          <input type="text" id="dealerCompanyName">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_contactName">Jméno a příjmení</label>
          <input type="text" id="dealerContactName">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_email">E-mail</label>
          <input type="email" id="dealerEmail">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_phone">Telefon</label>
          <input type="tel" id="dealerPhone">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_city">Město</label>
          <input type="text" id="dealerCity">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_vehiclesCount">Počet vozů v nabídce</label>
          <input type="number" id="dealerVehiclesCount" min="0">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_message">Zpráva (nepovinné)</label>
          <textarea id="dealerMessage" rows="3"></textarea>
        </div>
        <p class="form-status" id="dealerFormStatus"></p>
        <button type="submit" class="btn btn-brass btn-block" id="dealerSubmitBtn" data-i18n="partnersForm.submit">Odeslat poptávku</button>
      </form>
    </div>

    <div id="inspectorFormWrap" style="display:none;">
      <h3 data-i18n="partnersForm.inspector_title">Poptávka pro technika</h3>
      <form id="inspectorForm" novalidate>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_contactName">Jméno a příjmení</label>
          <input type="text" id="inspectorContactName">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_email">E-mail</label>
          <input type="email" id="inspectorEmail">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_phone">Telefon</label>
          <input type="tel" id="inspectorPhone">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_city">Město</label>
          <input type="text" id="inspectorCity">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_qualification">Kvalifikace / zkušenosti</label>
          <input type="text" id="inspectorQualification">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_availability">Dostupnost</label>
          <input type="text" id="inspectorAvailability">
        </div>
        <div class="modal-field">
          <label data-i18n="partnersForm.field_message">Zpráva (nepovinné)</label>
          <textarea id="inspectorMessage" rows="3"></textarea>
        </div>
        <p class="form-status" id="inspectorFormStatus"></p>
        <button type="submit" class="btn btn-brass btn-block" id="inspectorSubmitBtn" data-i18n="partnersForm.submit">Odeslat poptávku</button>
      </form>
    </div>

    <div class="modal-success" id="partnerModalSuccess">
      <div class="check-circle">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
      </div>
      <p data-i18n="partnersForm.success">Děkujeme! Ozveme se vám co nejdříve.</p>
      <button class="btn btn-ghost on-paper btn-block" id="partnerModalCloseBtn2" data-i18n="partnersForm.close">Zavřít</button>
    </div>
  </div>
</div>
`;

let overlayEl, dealerFormWrap, inspectorFormWrap, successEl;
let dealerForm, dealerStatus, dealerSubmitBtn;
let inspectorForm, inspectorStatus, inspectorSubmitBtn;

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function resetFormState(form, status, submitBtn) {
  form.reset();
  form.querySelectorAll('input, textarea').forEach((el) => el.classList.remove('field-invalid'));
  status.textContent = '';
  status.classList.remove('error');
  submitBtn.disabled = false;
  submitBtn.textContent = translate('partnersForm.submit');
}

function resetAll() {
  resetFormState(dealerForm, dealerStatus, dealerSubmitBtn);
  resetFormState(inspectorForm, inspectorStatus, inspectorSubmitBtn);
  dealerFormWrap.style.display = 'block';
  inspectorFormWrap.style.display = 'block';
  successEl.classList.remove('show');
}

export function init() {
  overlayEl = document.getElementById('partnerModalOverlay');
  dealerFormWrap = document.getElementById('dealerFormWrap');
  inspectorFormWrap = document.getElementById('inspectorFormWrap');
  successEl = document.getElementById('partnerModalSuccess');

  dealerForm = document.getElementById('dealerForm');
  dealerStatus = document.getElementById('dealerFormStatus');
  dealerSubmitBtn = document.getElementById('dealerSubmitBtn');

  inspectorForm = document.getElementById('inspectorForm');
  inspectorStatus = document.getElementById('inspectorFormStatus');
  inspectorSubmitBtn = document.getElementById('inspectorSubmitBtn');

  document.getElementById('partnerModalClose').addEventListener('click', close);
  document.getElementById('partnerModalCloseBtn2').addEventListener('click', close);
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  dealerForm.addEventListener('submit', (e) => handleSubmit(e, 'dealer_request'));
  inspectorForm.addEventListener('submit', (e) => handleSubmit(e, 'inspector_request'));
}

function collectDealerData() {
  return {
    type: 'dealer_request',
    companyName: document.getElementById('dealerCompanyName').value.trim(),
    contactName: document.getElementById('dealerContactName').value.trim(),
    email: document.getElementById('dealerEmail').value.trim(),
    phone: document.getElementById('dealerPhone').value.trim(),
    city: document.getElementById('dealerCity').value.trim(),
    vehiclesCount: document.getElementById('dealerVehiclesCount').value.trim(),
    message: document.getElementById('dealerMessage').value.trim(),
    language: getCurrentLang(),
    source: 'partners_form',
    pageUrl: window.location.href,
    createdAtClient: new Date().toISOString()
  };
}

function collectInspectorData() {
  return {
    type: 'inspector_request',
    contactName: document.getElementById('inspectorContactName').value.trim(),
    email: document.getElementById('inspectorEmail').value.trim(),
    phone: document.getElementById('inspectorPhone').value.trim(),
    city: document.getElementById('inspectorCity').value.trim(),
    qualification: document.getElementById('inspectorQualification').value.trim(),
    availability: document.getElementById('inspectorAvailability').value.trim(),
    message: document.getElementById('inspectorMessage').value.trim(),
    language: getCurrentLang(),
    source: 'partners_form',
    pageUrl: window.location.href,
    createdAtClient: new Date().toISOString()
  };
}

async function handleSubmit(e, type) {
  e.preventDefault();
  const isDealer = type === 'dealer_request';
  const wrap = isDealer ? dealerFormWrap : inspectorFormWrap;
  const status = isDealer ? dealerStatus : inspectorStatus;
  const submitBtn = isDealer ? dealerSubmitBtn : inspectorSubmitBtn;
  const idPrefix = isDealer ? 'dealer' : 'inspector';

  const fieldEls = wrap.querySelectorAll('input, textarea');
  fieldEls.forEach((el) => el.classList.remove('field-invalid'));
  status.textContent = '';
  status.classList.remove('error');

  const data = isDealer ? collectDealerData() : collectInspectorData();

  // --- basic frontend validation (client-side, mirrors api.js's own check) ---
  const missingIds = [];
  if (!data.contactName) missingIds.push(idPrefix + 'ContactName');
  if (!data.city) missingIds.push(idPrefix + 'City');
  if (isDealer && !data.companyName) missingIds.push('dealerCompanyName');
  if (!data.email) missingIds.push(idPrefix + 'Email');

  const emailInvalid = !!data.email && !isValidEmail(data.email);

  missingIds.forEach((id) => document.getElementById(id).classList.add('field-invalid'));
  if (emailInvalid) document.getElementById(idPrefix + 'Email').classList.add('field-invalid');

  if (missingIds.length > 0) {
    status.textContent = translate('partnersForm.error_required');
    status.classList.add('error');
    return;
  }
  if (emailInvalid) {
    status.textContent = translate('partnersForm.error_email');
    status.classList.add('error');
    return;
  }

  // --- submit to the mock API (single call site -> becomes POST /leads later) ---
  submitBtn.disabled = true;
  submitBtn.textContent = translate('partnersForm.sending');

  try {
    await submitLead(data);
    wrap.style.display = 'none';
    successEl.classList.add('show');
  } catch (err) {
    status.textContent = translate('partnersForm.error');
    status.classList.add('error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = translate('partnersForm.submit');
  }
}

/** Opens the modal showing the dealer request form. Called by Partners.js. */
export function openDealerForm() {
  resetAll();
  dealerFormWrap.style.display = 'block';
  inspectorFormWrap.style.display = 'none';
  overlayEl.classList.add('open');
}

/** Opens the modal showing the inspector request form. Called by Partners.js. */
export function openInspectorForm() {
  resetAll();
  dealerFormWrap.style.display = 'none';
  inspectorFormWrap.style.display = 'block';
  overlayEl.classList.add('open');
}

export function close() {
  overlayEl.classList.remove('open');
}

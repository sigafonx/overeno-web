import { createBooking } from '../api/api.js';
import { translate, getCurrentLang } from '../i18n/i18n.js';

export const html = `
<div class="modal-overlay" id="modalOverlay">
  <div class="modal-box">
    <button class="modal-close" id="modalClose">&times;</button>
    <form id="modalForm" novalidate>
      <h3 data-i18n="modal.title">Objednat prohlídku</h3>
      <p class="demo-note" id="modalVinNote" style="display:none;"></p>

      <div class="modal-field">
        <label data-i18n="modal.city_label">Vyberte město</label>
        <select id="modalCity">
          <option data-i18n="modal.city1">Praha</option>
          <option data-i18n="modal.city2">Brno</option>
          <option data-i18n="modal.city3">Ostrava</option>
          <option data-i18n="modal.city4">Plzeň</option>
        </select>
      </div>

      <div class="modal-field">
        <label data-i18n="modal.time_label">Vyberte termín</label>
        <div class="time-options">
          <label><input type="radio" name="slot" checked> <span data-i18n="modal.time1">Zítra 9:00</span></label>
          <label><input type="radio" name="slot"> <span data-i18n="modal.time2">Zítra 14:00</span></label>
          <label><input type="radio" name="slot"> <span data-i18n="modal.time3">Pozítří 10:00</span></label>
        </div>
      </div>

      <div class="modal-field">
        <label data-i18n="partnersForm.field_contactName">Jméno a příjmení</label>
        <input type="text" id="modalContactName">
      </div>

      <div class="modal-field">
        <label data-i18n="partnersForm.field_email">E-mail</label>
        <input type="email" id="modalEmail">
      </div>

      <div class="modal-field">
        <label data-i18n="partnersForm.field_phone">Telefon</label>
        <input type="tel" id="modalPhone">
      </div>

      <div class="modal-field">
        <label data-i18n="partnersForm.field_message">Zpráva (nepovinné)</label>
        <textarea id="modalMessage" rows="3"></textarea>
      </div>

      <p class="form-status" id="modalFormStatus"></p>
      <button type="submit" class="btn btn-brass btn-block" id="modalConfirm" data-i18n="modal.confirm">Odeslat poptávku</button>
    </form>
    <div class="modal-success" id="modalSuccess">
      <div class="check-circle">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
      </div>
      <p data-i18n="modal.success">Poptávka odeslána! Technik vás brzy bude kontaktovat.</p>
      <button class="btn btn-ghost on-paper btn-block" id="modalCloseBtn2" data-i18n="modal.close">Zavřít</button>
    </div>
  </div>
</div>
`;

let overlayEl, formEl, successEl;
let cityEl, contactNameEl, emailEl, phoneEl, messageEl, statusEl, confirmBtn, vinNoteEl;
let currentVin = '';

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function clearInvalid() {
  [cityEl, emailEl].forEach((el) => el && el.classList.remove('field-invalid'));
}

function resetForm() {
  formEl.reset();
  clearInvalid();
  statusEl.textContent = '';
  statusEl.classList.remove('error');
  confirmBtn.disabled = false;
  confirmBtn.textContent = translate('modal.confirm');
  formEl.style.display = 'block';
  successEl.classList.remove('show');
}

export function init() {
  overlayEl = document.getElementById('modalOverlay');
  formEl = document.getElementById('modalForm');
  successEl = document.getElementById('modalSuccess');
  cityEl = document.getElementById('modalCity');
  contactNameEl = document.getElementById('modalContactName');
  emailEl = document.getElementById('modalEmail');
  phoneEl = document.getElementById('modalPhone');
  messageEl = document.getElementById('modalMessage');
  statusEl = document.getElementById('modalFormStatus');
  confirmBtn = document.getElementById('modalConfirm');
  vinNoteEl = document.getElementById('modalVinNote');

  document.getElementById('modalClose').addEventListener('click', close);
  document.getElementById('modalCloseBtn2').addEventListener('click', close);
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  formEl.addEventListener('submit', handleSubmit);
}

function collectBookingData() {
  const checkedSlot = document.querySelector('input[name="slot"]:checked');
  return {
    vin: currentVin || '',
    city: cityEl.value,
    preferredSlot: checkedSlot ? checkedSlot.parentElement.textContent.trim() : '',
    contactName: contactNameEl.value.trim(),
    email: emailEl.value.trim(),
    phone: phoneEl.value.trim(),
    message: messageEl.value.trim(),
    language: getCurrentLang(),
    source: 'booking_modal',
    pageUrl: window.location.href,
    createdAtClient: new Date().toISOString()
  };
}

async function handleSubmit(e) {
  e.preventDefault();
  clearInvalid();
  statusEl.textContent = '';
  statusEl.classList.remove('error');

  const data = collectBookingData();

  // --- basic frontend validation (mirrors the backend's own rules) ---
  if (!data.city || !data.preferredSlot) {
    statusEl.textContent = translate('partnersForm.error_required');
    statusEl.classList.add('error');
    return;
  }

  if (!data.email && !data.phone) {
    statusEl.textContent = translate('modal.error_contact_required');
    statusEl.classList.add('error');
    return;
  }

  if (data.email && !isValidEmail(data.email)) {
    emailEl.classList.add('field-invalid');
    statusEl.textContent = translate('partnersForm.error_email');
    statusEl.classList.add('error');
    return;
  }

  // --- submit (single call site -> becomes POST /bookings via api.js) ---
  confirmBtn.disabled = true;
  confirmBtn.textContent = translate('partnersForm.sending');

  try {
    await createBooking(data);
    formEl.style.display = 'none';
    successEl.classList.add('show');
  } catch (err) {
    statusEl.textContent = translate('partnersForm.error');
    statusEl.classList.add('error');
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = translate('modal.confirm');
  }
}

/**
 * Opens the modal. `vin` is optional — VinDemo passes the VIN currently in
 * its input field so a booking made right after a VIN check carries that
 * VIN along; any other caller can omit it.
 */
export function open(vin = '') {
  currentVin = vin;
  resetForm();

  if (currentVin) {
    vinNoteEl.textContent = `VIN: ${currentVin}`;
    vinNoteEl.style.display = 'block';
  } else {
    vinNoteEl.style.display = 'none';
  }

  overlayEl.classList.add('open');
}

export function close() {
  overlayEl.classList.remove('open');
}

import { submitLead, createPaymentCheckout } from '../api/api.js';
import { getCurrentLang } from '../i18n/i18n.js';

export const html = `
<section class="final-cta">
  <div class="wrap final-inner">
    <h2 data-i18n="final.heading">Připraveni koupit vůz s jistotou?</h2>
    <p data-i18n="final.sub">Vložte VIN nebo odkaz na inzerát a do pár minut budete vědět víc, než vám řekne prodejce.</p>
    <form class="final-form" id="finalForm">
      <input type="email" required data-i18n-ph="final.email_ph" placeholder="Váš e-mail">
      <button type="submit" class="btn btn-brass" data-i18n="final.button">Prověřit vůz teď</button>
    </form>
    <p class="final-success" id="finalSuccess" data-i18n="final.success">Díky! Ozveme se vám.</p>

    <div style="margin-top:32px;padding-top:22px;border-top:1px solid rgba(236,231,218,0.15);">
      <p class="demo-note" style="margin-bottom:10px;">Testovací platba (dev) — simuluje zálohu na objednání prohlídky, žádné skutečné peníze.</p>
      <button type="button" class="btn btn-ghost" id="testPaymentBtn">Pay inspection deposit (test)</button>
      <p class="demo-error" id="testPaymentStatus" style="display:none;"></p>
    </div>
  </div>
</section>
`;

export function init() {
  const form = document.getElementById('finalForm');
  const success = document.getElementById('finalSuccess');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.querySelector('input[type="email"]').value;

    // Single call site for lead capture. submitLead() itself decides
    // whether this hits the real POST /leads backend or the local mock.
    await submitLead({
      type: 'final_cta',
      source: 'final_cta',
      email,
      language: getCurrentLang(),
      pageUrl: window.location.href,
      createdAtClient: new Date().toISOString()
    });

    success.classList.add('show');
    form.reset();
  });

  // Separate, self-contained test-payment button — does not touch the lead
  // form above at all. Deliberately no mock fallback: if payments are
  // disabled or the backend is unreachable, this should say so plainly.
  const testPaymentBtn = document.getElementById('testPaymentBtn');
  const testPaymentStatus = document.getElementById('testPaymentStatus');

  testPaymentBtn.addEventListener('click', async () => {
    testPaymentStatus.style.display = 'none';
    testPaymentBtn.disabled = true;

    try {
      const result = await createPaymentCheckout({
        productCode: 'inspection_booking_deposit',
        entityType: 'booking'
      });

      if (result.payment && result.payment.checkoutUrl) {
        window.location.href = result.payment.checkoutUrl;
      } else {
        throw new Error('Backend did not return a checkout URL.');
      }
    } catch (err) {
      testPaymentStatus.textContent = err.message;
      testPaymentStatus.style.display = 'block';
      testPaymentBtn.disabled = false;
    }
  });
}

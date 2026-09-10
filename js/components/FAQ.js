export const html = `
<section class="on-paper" id="faq">
  <div class="wrap">
    <div class="section-head">
      <h2 data-i18n="faq.heading">Časté otázky</h2>
    </div>
    <div class="faq-list" id="faqList">
      <div class="faq-item">
        <button class="faq-q"><span data-i18n="faq.q1">Jak dlouho trvá kontrola VIN?</span><span class="plus">+</span></button>
        <div class="faq-a"><p data-i18n="faq.a1">Základní report je hotový do pár minut, fyzická prohlídka technikem obvykle do 48 hodin od objednání.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q"><span data-i18n="faq.q2">Funguje to i pro vozy dovezené ze zahraničí?</span><span class="plus">+</span></button>
        <div class="faq-a"><p data-i18n="faq.a2">Ano, kontrolujeme i vozy dovezené z Německa, Belgie, Nizozemska a dalších zemí EU.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q"><span data-i18n="faq.q3">Co když technik najde vážnou vadu?</span><span class="plus">+</span></button>
        <div class="faq-a"><p data-i18n="faq.a3">Dostanete přehlednou zprávu s doporučením a můžete od koupě ustoupit nebo vyjednat nižší cenu.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q"><span data-i18n="faq.q4">Jak se stanu partnerským technikem?</span><span class="plus">+</span></button>
        <div class="faq-a"><p data-i18n="faq.a4">Vyplníte krátký formulář, ověříme vaši kvalifikaci a domluvíme první zkušební objednávky ve vašem regionu.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q"><span data-i18n="faq.q5">Je odznak Ověřeno zárukou bez vad?</span><span class="plus">+</span></button>
        <div class="faq-a"><p data-i18n="faq.a5">Ne, snižuje riziko a odhaluje běžné problémy, ale nenahrazuje vlastní úsudek kupujícího.</p></div>
      </div>
    </div>
  </div>
</section>
`;

export function init() {
  document.querySelectorAll('.faq-item').forEach((item) => {
    const question = item.querySelector('.faq-q');
    const answer = item.querySelector('.faq-a');

    question.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');

      document.querySelectorAll('.faq-item').forEach((i) => {
        i.classList.remove('open');
        i.querySelector('.faq-a').style.maxHeight = null;
      });

      if (!isOpen) {
        item.classList.add('open');
        answer.style.maxHeight = answer.scrollHeight + 'px';
      }
    });
  });
}

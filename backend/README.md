# nexium-backend

Минимальный Express-backend для NEXIUM. Умеет: принимать и сохранять
лиды (`POST /leads`), заявки на осмотр (`POST /bookings`) и VIN-проверки
(`POST /vin/check`) — и отдавать их в admin-эндпоинты (`/admin/leads/*`,
`/admin/bookings/*`, `/admin/vin-checks/*` и `/admin/payments/*` — у всех
трёх из PATCH только `.../note` и `.../assign`, без смены статуса и без
DELETE — `/admin/email-logs/*` с поиском, CSV-экспортом и PATCH
`.../review` для ручного reviewed/resolved/заметки). Плюс полный CRUD
`/admin/agents/*` (см. «Агенты» ниже) и sandbox-платежи
(`POST /payments/checkout`, `POST /payments/webhook`) — см. раздел
«Платежи» ниже.

**Важно про `POST /vin/check`:** это demo-проверка. Результат генерируется
детерминированно из строки VIN (тот же VIN → тот же результат), это не
запрос к реальной базе истории автомобилей. В ответе всегда есть
`result.isDemoResult: true` и `result.disclaimer`. Позже сюда можно
подключить настоящего VIN data provider — поменяется только генерация
`result` внутри `POST /vin/check`, контракт ответа можно сохранить.

## Платежи (sandbox/test layer — НЕ production billing)

Фундамент для разовых оплат: провайдер-агностичная архитектура,
mock-провайдер по умолчанию, опционально Stripe (только test mode).

```
backend/payments/
├── paymentConfig.js       PAYMENTS_ENABLED / PAYMENT_PROVIDER — читаются отсюда
├── products.js             Единственный источник цены — frontend цену НЕ передаёт
├── paymentProvider.js      getPaymentProvider() — фабрика mock/stripe
├── mockPaymentProvider.js  Полностью протестировано в этой среде
├── stripeProvider.js       ⚠️ НЕ протестировано в этой среде (см. ниже)
└── paymentService.js       Бизнес-логика: createCheckout(), applyWebhookEvent()
```

**Честно про Stripe:** `stripeProvider.js` написан по документации Stripe
максимально аккуратно, но **не был реально вызван** — в этой песочнице
нет сети до `api.stripe.com` и не было реальных (даже test-mode) ключей.
Считайте его reviewed-but-unverified: код должен работать, но перед
реальным использованием нужно проверить на настоящем Stripe test-аккаунте.
Если у вас есть Stripe-ключи — весь остальной код (checkout endpoint,
webhook routing, admin-панель) уже готов работать с ним без изменений,
нужно только заполнить `.env`. Пошаговая инструкция — раздел
**«Stripe test mode setup»** ниже.

### Как включить

```bash
# backend/.env
PAYMENTS_ENABLED=true
PAYMENT_PROVIDER=mock   # или "stripe"
```

С `PAYMENTS_ENABLED=false` (по умолчанию) `POST /payments/checkout`
отвечает понятной ошибкой (`503 PAYMENTS_DISABLED`), backend не падает,
остальной сайт не затронут.

Если `PAYMENT_PROVIDER=stripe`, но `STRIPE_SECRET_KEY` не задан — backend
всё равно стартует нормально (с предупреждением в консоли), просто
`POST /payments/checkout` вернёт `503 PROVIDER_NOT_CONFIGURED`.

### Продукты (единственный источник цены)

| productCode | Название | amount (minor units) | В кронах |
|---|---|---|---|
| `vin_basic_report` | VIN Basic Report | 9900 | 99,00 Kč |
| `inspection_booking_deposit` | Vehicle Inspection Booking Deposit | 49900 | 499,00 Kč |
| `manual_car_review` | Manual Car Review | 19900 | 199,00 Kč |

`amount` хранится в minor units по конвенции Stripe для CZK (стандартная
2-знаковая валюta, не zero-decimal, как JPY) — `9900` значит 99,00 Kč.
Frontend **никогда** не передаёт `amount`/`currency` — только `productCode`,
backend сам подставляет цену из `products.js`; попытка передать цену с
фронта молча игнорируется (проверено вживую).

### Создать mock checkout

```bash
curl -X POST http://localhost:3001/payments/checkout \
  -H "Content-Type: application/json" \
  -d '{
    "productCode": "inspection_booking_deposit",
    "entityType": "booking",
    "entityId": "booking_xxx",
    "customerEmail": "test@example.com",
    "customerName": "Test User"
  }'
```

Ответ (HTTP 201):

```json
{
  "ok": true,
  "payment": {
    "id": "payment_xxxxxxxxxxxx",
    "status": "checkout_created",
    "productCode": "inspection_booking_deposit",
    "amount": 49900,
    "currency": "CZK",
    "provider": "mock",
    "checkoutUrl": "http://localhost:8000/payment-success.html?mock=1&payment_id=...&session_id=..."
  }
}
```

У mock-провайдера нет настоящей хостованной checkout-страницы — `checkoutUrl`
ведёт прямо на `payment-success.html` с пометкой `mock=1` (страница честно
показывает, что это была тестовая симуляция, не настоящая оплата).

### Протестировать mock webhook

Извлеките `session_id` из `checkoutUrl` выше, затем:

```bash
# успешная оплата
curl -X POST http://localhost:3001/payments/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"payment.paid","providerSessionId":"mock_session_xxx","providerPaymentId":"pi_test_123"}'

# отмена
curl -X POST http://localhost:3001/payments/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"payment.cancelled","providerSessionId":"mock_session_xxx"}'

# истечение срока checkout-сессии (Stripe: checkout.session.expired) —
# отдельный статус, не переиспользует "отмену"
curl -X POST http://localhost:3001/payments/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"payment.expired","providerSessionId":"mock_session_xxx"}'

# ошибка оплаты
curl -X POST http://localhost:3001/payments/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"payment.failed","providerSessionId":"mock_session_xxx","errorMessage":"Card declined"}'
```

Каждый переводит `payment.status` в `paid`/`cancelled`/`expired`/`failed`
и проставляет соответствующий timestamp (`paidAt`/`cancelledAt`/
`expiredAt`/`failedAt`). Идемпотентно для всех четырёх — повторный
webhook с тем же типом на уже-переведённый в этот статус платёж не
меняет timestamp повторно.

### Связь оплаты с booking / vin_check

Когда webhook переводит платёж в `paid`, `applyPaymentToEntity()` в
`paymentService.js` смотрит на комбинацию `productCode` + `entityType`
и, если она совпадает с известным правилом, обновляет связанную запись:

| productCode | entityType | Что происходит |
|---|---|---|
| `inspection_booking_deposit` | `booking` | `bookings.status = 'paid'`, плюс `paidAt`/`paymentId` |
| `vin_basic_report` | `vin_check` | `vin_checks.paymentStatus = 'paid'`, плюс `paidAt`/`paymentId` (поле `status` у vin_check — «completed» — не трогается, это разные вещи) |
| `manual_car_review` | `manual_review` | Ничего не обновляется — платёж просто остаётся `paid`, связывать пока не с чем (осознанно, на этом этапе) |

**Payment остаётся отдельной финансовой записью** — обновление
booking/vin_check это побочный эффект, а не замена платёжной таблицы.

**Если сущность не найдена** (например, `entityId` указывает на
удалённый booking): payment всё равно становится `paid` — деньги же
реально пришли — backend не падает, но предупреждение записывается в
`payments.metadataJson` (JSON `{ "linkingWarning": "...", "warnedAt": "..." }`)
и дублируется в консоль сервера (`console.warn`). Никакого отдельного
поля для этого не заводили, чтобы не путать с `errorMessage` (которое
означает «сама оплата не прошла», а не «оплата прошла, но привязать
не к чему»).

### Идемпотентность webhook

Повторный `payment.paid` webhook для уже оплаченного платежа —
безопасный no-op:

- `payment.status` остаётся `paid`, **`paidAt` не перезаписывается**;
- `applyPaymentToEntity()` не вызывается повторно — связанный
  booking/vin_check не трогается второй раз;
- повторное admin-письмо не отправляется;
- ответ webhook всё равно `{ "ok": true, ... }` — провайдер (или ваш
  тестовый curl) не увидит ошибку и не будет ретраить бесконечно.

Проверить вживую: отправьте один и тот же `payment.paid` webhook дважды
подряд (см. примеры ниже) и сравните `paidAt` до/после второго вызова —
должны быть идентичны посимвольно.

### Stripe webhook — техническая деталь

`POST /payments/webhook` зарегистрирован **до** `express.json()` в
`server.js` и использует отдельный `express.raw()` только для этого
пути — это нужно, чтобы Stripe мог проверить подпись по точным сырым
байтам запроса. Остальные endpoints как обычно используют JSON-парсер.

### Проверить связку booking → paid (полный цикл)

```bash
# 1. создать booking
curl -X POST http://localhost:3001/bookings -H "Content-Type: application/json" \
  -d '{"city":"Praha","preferredSlot":"Tomorrow 9:00","email":"buyer@example.com"}'
# -> скопируйте "id" из ответа как BOOKING_ID

# 2. создать checkout, привязанный к этому booking
curl -X POST http://localhost:3001/payments/checkout -H "Content-Type: application/json" \
  -d '{"productCode":"inspection_booking_deposit","entityType":"booking","entityId":"BOOKING_ID"}'
# -> скопируйте session_id из checkoutUrl в ответе

# 3. отправить mock webhook paid
curl -X POST http://localhost:3001/payments/webhook -H "Content-Type: application/json" \
  -d '{"type":"payment.paid","providerSessionId":"SESSION_ID"}'

# 4. проверить booking
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/bookings/BOOKING_ID
# -> item.status должен быть "paid", item.paidAt и item.paymentId заполнены
```

Тот же принцип для VIN-проверки — только `productCode: "vin_basic_report"`,
`entityType: "vin_check"`, и в `admin-vin-checks.html`/`GET /admin/vin-checks/:id`
смотрите поля `paymentStatus`/`paidAt`/`paymentId` (не `status` — он у
VIN-проверки означает завершённость проверки, не оплату).

### Admin panel — Platby (read-only, kromě interní poznámky)

Otevřete `http://localhost:8000/admin-payments.html`. Stejný princip
jako ostatní read-only admin stránky — filtry (`status`, `productCode`,
`entityType`, `entityId`, `customerEmail`, fulltextové `search`), detail,
CSV export. Pořád **žádná změna statusu, žádné DELETE** — platba je
účetní záznam, to zůstává mimo scope. Detail navíc ukáže jednoduchou
textovou nápovědu, kde hledat propojený booking/vin_check
(`admin-bookings.html` / `admin-vin-checks.html`, podle ID entity) —
záměrně bez klikacího deep-linku, aby se nemusela řešit synchronizace
filtrů mezi stránkami.

**Jediná editace na této stránce:** interní admin poznámka
(`internalNote`) — v detailu textarea + tlačítko „Save note". Čistě
pro interní použití, **nijak neovlivňuje `status` platby** ani žádnou
webhook/linking logiku. Poznámka se při každém otevření detailu načte
znovu ze serveru (`GET /admin/payments/:id`), ne jen z lokální
mezipaměti seznamu — takže vždy vidíte aktuální stav, i po uložení
z jiného okna/zařízení. Do tabulky sloupec s poznámkou záměrně
nepřidáván, aby seznam zůstal přehledný — jen detail.

```bash
# 401 bez hesla
curl -i http://localhost:3001/admin/payments

# seznam s heslem
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/payments

# export CSV
curl "http://localhost:3001/admin/payments/export.csv?status=paid" \
  -H "x-admin-password: VASE_HESLO" \
  -o payments_paid.csv

# uložit interní poznámku
curl -X PATCH "http://localhost:3001/admin/payments/<ID>/note" \
  -H "Content-Type: application/json" \
  -H "x-admin-password: VASE_HESLO" \
  -d '{"internalNote":"Customer asked for refund, checking with finance"}'

# vymazat poznámku (prázdný řetězec je platná hodnota)
curl -X PATCH "http://localhost:3001/admin/payments/<ID>/note" \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"internalNote":""}'
```

Poznámky k `PATCH /admin/payments/:id/note`:

- odpověď je `{ "ok": true, "payment": { ... } }` (klíč `payment`, stejný
  styl jako u `POST /payments/checkout`);
- `internalNote` musí být string a **musí být přítomné** v payloadu —
  chybějící pole je 400, prázdný řetězec je v pořádku (a poznámku vymaže);
- limit je **5000 znaků**, stejně jako u VIN-check a email-log poznámek;
- nemění `status`, `paidAt`, `paymentId` ani žádnou webhook/linking
  logiku — čistě kosmetická admin poznámka.

### Bezpečnost

- Nikdy neukládejte reálné Stripe/SMTP klíče do `.env.example` ani do
  žádného souboru, který opustí váš stroj — jen do lokálního `.env`.
- I s reálným Stripe účtem používejte **výhradně test mode** klíče
  (`sk_test_...`), dokud nebude tento krok vědomě rozšířen o produkční
  bezpečnostní revizi. Rate limiting na `POST /payments/checkout` už
  existuje (viz produkční hardening výše) — idempotency klíče na
  odchozích požadavcích k providerovi a retry logika nedoručených
  webhooků pořád nejsou implementovány.

## Stripe test mode setup

Krok za krokem, jak zapnout skutečný Stripe (test mode — **nikdy live**,
dokud tenhle krok vědomě neprojde produkční revizí) místo mock providera.

### 1. Kde vzít `STRIPE_SECRET_KEY`

Stripe Dashboard → přepnout vlevo nahoře na **Test mode** → Developers →
API keys → "Secret key". Začíná `sk_test_...`. Nikdy `sk_live_...` na
tomto kroku.

### 2. Jak nastavit `STRIPE_WEBHOOK_SECRET`

Dvě cesty, podle toho, jestli backend běží lokálně nebo je nasazený:

**Lokálně (Stripe CLI)** — nejrychlejší pro vývoj/testování:

```bash
stripe login
stripe listen --forward-to localhost:3001/payments/webhook
```

Vypíše `whsec_...` hodnotu — tu vložte do `STRIPE_WEBHOOK_SECRET`.
Dokud `stripe listen` běží, každý test-checkout doručí webhook přímo
sem.

**Nasazený backend (Stripe Dashboard)**:

Developers → Webhooks → Add endpoint → URL `https://<váš-backend-domain>/payments/webhook`
→ vyberte aspoň tyto tři eventy (víc nevadí, ostatní se ignorují):

- `checkout.session.completed`
- `checkout.session.expired`
- `payment_intent.payment_failed`

Po vytvoření Stripe zobrazí "Signing secret" — to je `STRIPE_WEBHOOK_SECRET`.

### 3. Zapnutí

```bash
PAYMENTS_ENABLED=true
PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUCCESS_URL=http://localhost:8000/payment-success.html
STRIPE_CANCEL_URL=http://localhost:8000/payment-cancel.html
APP_URL=http://localhost:8000
```

Restartujte backend — v startup logu by mělo zmizet varování o chybějícím
`STRIPE_SECRET_KEY` a `payments:` řádek by měl ukazovat `ENABLED (provider: stripe)`.

### 4. Vytvoření test checkoutu

```bash
curl -X POST http://localhost:3001/payments/checkout \
  -H "Content-Type: application/json" \
  -d '{"productCode":"vin_basic_report","entityType":"vin_check"}'
```

`checkoutUrl` v odpovědi by měl být skutečná Stripe URL
(`https://checkout.stripe.com/...`), ne mock. Otevřete ji v prohlížeči a
zaplaťte [testovací kartou](https://stripe.com/docs/testing#cards) —
např. `4242 4242 4242 4242`, libovolné budoucí datum, libovolný CVC.

### 5. Ověření ve `admin-payments.html`

Po dokončení checkoutu (a doručení webhooku — se `stripe listen` běžícím
na pozadí je to automatické) otevřete `admin-payments.html`:

- `provider` = `stripe`;
- `status` = `paid`;
- `providerSessionId` vyplněné (Stripe session id, `cs_test_...`);
- `providerPaymentId` vyplněné, pokud ho webhook obsahoval (Stripe
  payment intent id, `pi_...`);
- `paidAt` vyplněné.

### 6. Ověření, že booking/vin_check dostal `paid` stav

Pokud `entityType`/`entityId` v checkoutu odkazovaly na existující
booking/vin_check — otevřete `admin-bookings.html` / `admin-vin-checks.html`,
najděte záznam podle `entityId` a zkontrolujte `Zaplaceno` (`paidAt`) a
u bookingu i `paymentId`.

### 7. Testovací scénáře k projetí

| Scénář | Jak vyvolat | Očekávaný výsledek |
|---|---|---|
| **success** | zaplatit testovací kartou `4242 4242 4242 4242` | `payment.status = paid`, entita spojená přes `entityId` dostane paid stav |
| **cancel** | na Stripe checkout stránce kliknout zpět/zavřít | `payment.status = cancelled`, žádná entita se nemění |
| **expired** | nechat checkout session vypršet (Stripe default ~24h — pro rychlejší test lze session vytvořit s kratší expirací přes Stripe API/Dashboard) | `payment.status = expired`, `expiredAt` vyplněné, `cancelledAt`/`paidAt` zůstávají prázdné |
| **failed** | zaplatit testovací kartou pro selhání, např. `4000 0000 0000 0002` (decline) | `payment.status = failed`, `errorMessage` obsahuje důvod |

### 8. Live mode

**Zakázáno**, dokud tento krok neprojde vědomě rozšířenou produkční
revizí (viz „Bezpečnost" výše a „Известные ограничения" níže —
idempotency klíče, retry logika webhooků). `sk_live_...`/`whsec_...`
z produkčního Stripe účtu nepoužívejte, dokud tahle podmínka není
splněná.

## Email-уведомления

После сохранения lead/booking/vin-check backend пытается отправить email
администратору и (если есть адрес) пользователю. **Порядок принципиален:**
сначала запись сохраняется в SQLite, только потом backend пробует
отправить письма — и если SMTP упадёт или не настроен, это никак не
влияет на уже сохранённую запись и на HTTP-ответ.

```
backend/email/
├── emailClient.js    Единственное место, которое знает про nodemailer/SMTP.
│                      sendEmail() никогда не бросает исключение.
├── templates.js       6 шаблонов (admin/user × lead/booking/vin-check),
│                      html + text-версия
└── emailService.js    sendLeadEmails()/sendBookingEmails()/sendVinCheckEmails() —
                        бизнес-логика: кому писать, логирование в email_logs
```

**Включение:** по умолчанию `EMAIL_ENABLED=false` — ничего не отправляется,
но всё остальное работает как раньше. Чтобы включить:

```bash
# backend/.env
EMAIL_ENABLED=true
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
ADMIN_EMAIL=you@example.com
```

Если `EMAIL_ENABLED=true`, но `SMTP_HOST` не задан — backend **не падает**,
просто каждая попытка отправки логируется как `failed` с понятным
сообщением об ошибке. Если оба `ADMIN_EMAIL`/`ADMIN_NOTIFICATION_EMAIL`
пустые — admin-письмо просто пропускается (`skipped`), запись всё равно
сохраняется.

**Провайдер:** сейчас — SMTP через `nodemailer`. Заменить на
Resend/SendGrid/Mailgun позже — значит переписать только
`backend/email/emailClient.js` (его единственный публичный контракт —
`sendEmail({ to, subject, html, text })`), `emailService.js` и route
handlers трогать не придётся.

**Логирование попыток (`email_logs`):** пишется **каждая** попытка,
включая пропущенные (`skipped`) — так видно, что система вообще пыталась
отправить письмо, даже когда `EMAIL_ENABLED=false`. Чтобы выключить
логирование целиком — `EMAIL_LOGGING_ENABLED=false`.

**Ответ endpoint'ов теперь содержит дополнительное поле** (не ломает
существующий frontend — он его просто игнорирует):

```json
{ "...": "как раньше", "email": { "adminEmailSent": true, "userEmailSent": false } }
```

**VIN-проверка:** у `vin_checks` пока нет поля email вообще (VIN-форма
на сайте email не собирает) — поэтому `userEmailSent` для VIN-проверки
всегда `false`, это ожидаемо, а не баг.

## Хранилище: SQLite (не JSON)

С этого этапа основное хранилище — **SQLite** (`better-sqlite3`), файл
`backend/data/overeno.sqlite`. Все существующие endpoints и форматы
ответов не изменились — поменялся только слой хранения данных.

```
backend/
├── db/
│   ├── database.js        Открывает overeno.sqlite, создаёт схему при старте
│   ├── schema.js           CREATE TABLE/INDEX IF NOT EXISTS для leads/bookings/vin_checks
│   └── repositories/
│       ├── leadsRepository.js
│       ├── bookingsRepository.js
│       └── vinChecksRepository.js   (хранит result.* как плоские колонки,
│                                      наружу отдаёт как раньше — вложенный result)
├── scripts/
│   └── migrate-json-to-sqlite.js    Перенос старых backend/data/*.json → SQLite
```

База создаётся автоматически при первом запуске (`npm run dev`/`npm start`)
— ничего вручную готовить не нужно. Таблицы и индексы создаются через
`CREATE ... IF NOT EXISTS`, так что повторный запуск ничего не ломает.

**Почему SQLite, а не сразу PostgreSQL:** для текущего MVP (один процесс,
один сервер, ещё нет реальных платежей/нагрузки) SQLite — это файл на
диске без отдельного сервера БД, `better-sqlite3` — синхронный и самый
простой в использовании клиент для Node.js, а WAL-режим уже снимает
главную боль JSON-хранилища — конкурентную запись/чтение. Переходить на
PostgreSQL стоит, когда появится: несколько процессов backend
одновременно, реальная нагрузка/много одновременных клиентов, или
потребность в репликации/бэкапах на уровне СУБД.

## Миграция старых JSON-данных

Если у вас остались старые `backend/data/leads.json` /
`bookings.json` / `vin_checks.json` с реальными записями:

```bash
cd backend
npm run migrate:json
```

Скрипт читает все три JSON-файла (не падает, если какого-то нет или он
пустой), вставляет записи в SQLite и пропускает дубликаты по `id` — его
можно запускать повторно без риска задвоить данные. В конце печатает
отчёт:

```
leads migrated: X
bookings migrated: X
vin checks migrated: X
skipped duplicates: X
```

JSON-файлы после миграции **не удаляются** — оставлены как legacy/backup,
backend их больше не читает и не пишет.

## Сброс базы для разработки

```bash
rm backend/data/overeno.sqlite backend/data/overeno.sqlite-wal backend/data/overeno.sqlite-shm
npm run dev  # пересоздаст пустую базу при старте
```

## 1. Запуск backend

```bash
cd backend
cp .env.example .env
# otevřete .env a nastavte vlastní ADMIN_PASSWORD
npm install
npm run dev
```

`npm run dev` перезапускает сервер при изменении файлов (`node --watch`).
Для обычного запуска без watch-режима — `npm start`.

По умолчанию сервер слушает порт **3001** (`.env` → `PORT`). Файл `.env`
теперь подгружается автоматически при старте (через `dotenv`). Если
`.env` не создан или `ADMIN_PASSWORD` в нём не задан — сервер стартует
с небезопасным значением `change_me` и громко предупреждает об этом
в консоли.

### CORS

Список разрешённых origin — переменная `CORS_ORIGINS` в `.env`,
через запятую:

```bash
CORS_ORIGINS=https://nexium.cz,https://www.nexium.cz
```

Если `CORS_ORIGINS` не задан или пустой — используется безопасный
fallback на локальные dev-порты (`localhost:8000`, `127.0.0.1:8000`,
`localhost:5500`, `127.0.0.1:5500`). Никакого wildcard-fallback нет —
либо явный список из `.env`, либо только localhost, никогда «всё
разрешено». Backend при старте всегда печатает в консоль, какие origin
сейчас разрешены, и явно предупреждает, если список всё ещё
localhost-only (см. «Production checklist» ниже).

## 2. Запуск frontend

Из корня проекта (не из `backend/`):

```bash
python3 -m http.server 8000
```

и открыть `http://localhost:8000`. Backend по умолчанию (без
`CORS_ORIGINS` в `.env`) разрешает CORS именно для этого порта (и для
`5500`, если используется расширение Live Server) — см. раздел «CORS»
ниже за тем, как это переопределить для реального домена.

Если backend не запущен — сайт не падает: формы партнёров, финальная
форма, модалка заказа осмотра и VIN-demo автоматически используют
старый mock (с задержкой и случайной ошибкой у лидов, как было раньше).
Подробнее — в отчётах по соответствующим этапам.

## 3. Проверить `GET /health`

```bash
curl http://localhost:3001/health
```

Ожидаемый ответ:

```json
{ "ok": true, "service": "nexium-backend", "version": "0.1.0" }
```

## 4. Отправить тестовый lead через curl

Dealer-заявка:

```bash
curl -X POST http://localhost:3001/leads \
  -H "Content-Type: application/json" \
  -d '{
    "type":"dealer_request",
    "companyName":"Test Auto",
    "contactName":"Jan Novak",
    "email":"test@example.com",
    "city":"Praha",
    "language":"cs",
    "source":"partners_form"
  }'
```

Ожидаемый ответ (HTTP 201):

```json
{ "ok": true, "id": "lead_xxxxxxxxxxxx", "status": "new", "type": "dealer_request", "message": "Lead saved successfully" }
```

Пример невалидного запроса (проверка ошибки):

```bash
curl -i -X POST http://localhost:3001/leads \
  -H "Content-Type: application/json" \
  -d '{"type":"dealer_request","email":"not-an-email"}'
```

Ожидаемый ответ — HTTP 400:

```json
{ "ok": false, "error": "VALIDATION_ERROR", "message": "..." }
```

## 5. Проверить, что запись сохранилась

```bash
sqlite3 data/overeno.sqlite "SELECT id, type, status, email FROM leads ORDER BY createdAt DESC LIMIT 5;"
```

(если `sqlite3` CLI не установлен — то же самое видно через
`GET /admin/leads`, см. раздел 6 ниже). Новая заявка должна быть новой
строкой в таблице `leads` с полями `id`, `type`, `status: "new"`,
`createdAt`, `updatedAt` и остальными данными из запроса. База и таблицы
создаются автоматически при первом старте сервера.

## 5a. Отправить тестовую booking-заявку через curl

```bash
curl -X POST http://localhost:3001/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "city":"Praha",
    "preferredSlot":"Tomorrow 9:00",
    "contactName":"Test Buyer",
    "email":"buyer@example.com",
    "phone":"+420777111222",
    "language":"cs",
    "source":"booking_modal"
  }'
```

Ожидаемый ответ (HTTP 201):

```json
{ "ok": true, "id": "booking_xxxxxxxxxxxx", "status": "new", "message": "Booking saved successfully" }
```

Проверка ошибки (не хватает и email, и phone):

```bash
curl -i -X POST http://localhost:3001/bookings \
  -H "Content-Type: application/json" \
  -d '{"city":"Praha","preferredSlot":"Tomorrow 9:00"}'
```

Ожидаемый ответ — HTTP 400:

```json
{ "ok": false, "error": "VALIDATION_ERROR", "message": "Either email or phone is required." }
```

Результат так же можно проверить `SELECT * FROM bookings` в
`data/overeno.sqlite` — та же таблица `overeno.sqlite`, отдельная от `leads`.

## 5b. Отправить тестовую VIN-проверку через curl

```bash
curl -X POST http://localhost:3001/vin/check \
  -H "Content-Type: application/json" \
  -d '{
    "vin":"TMBJJ7NX0K0123456",
    "language":"cs",
    "source":"vin_demo"
  }'
```

Ожидаемый ответ (HTTP 201):

```json
{
  "ok": true,
  "id": "vincheck_xxxxxxxxxxxx",
  "status": "completed",
  "result": {
    "score": 82,
    "riskLevel": "low",
    "year": 2019,
    "estimatedMileage": 128000,
    "advertisedMileage": 121000,
    "accidents": 0,
    "owners": 2,
    "odometerRisk": "low",
    "verdictKey": "verdict_good",
    "isDemoResult": true,
    "disclaimer": "Demo result. Not an official vehicle history report."
  }
}
```

Тот же VIN всегда даёт тот же `result` — это демонстрационные данные,
детерминированные по строке VIN, **не настоящая проверка истории
автомобиля**. Проверка ошибки (слишком короткий VIN):

```bash
curl -i -X POST http://localhost:3001/vin/check \
  -H "Content-Type: application/json" \
  -d '{"vin":"AB"}'
```

→ HTTP 400, `{ "ok": false, "error": "VALIDATION_ERROR", "message": "..." }`.

Admin-эндпоинты и `admin-vin-checks.html` описаны ниже, в разделе 6b.

## 6. Admin panel — přehled leadů

Otevřete `admin-leads.html` (ze stejného frontendového serveru jako
`index.html`, tedy např. `http://localhost:8000/admin-leads.html`).

1. Zadejte heslo z `ADMIN_PASSWORD` (v `.env`) do pole nahoře a klikněte
   na „Načíst leady“. Heslo se ukládá jen do `sessionStorage` prohlížeče
   (mizí při zavření karty), nikdy do `localStorage`.
2. Filtrujte podle typu, stavu, nebo hledejte podle e-mailu / firmy /
   jména / města.
3. Kliknutím na „Detail“ u řádku otevřete modální okno se všemi údaji,
   kde lze změnit stav (`new` → … → `converted` / `spam` / `archived`)
   a přidat interní poznámku. Tlačítko „Smazat lead“ vyžaduje potvrzení.
   Detail se při každém otevření potvrdí čerstvým `GET /admin/leads/:id`
   (ne jen z lokální mezipaměti seznamu) — takže vždy vidíte aktuální
   stav/poznámku, i po uložení odjinud.
4. „Export CSV“ stáhne seznam leadů jako `.csv` se všemi sloupci —
   **respektuje aktuálně nastavené filtry** (typ, stav, hledání), takže
   export odpovídá tomu, co je zrovna vidět v tabulce. Otevře se správně
   i s českou/ruskou/ukrajinskou diakritikou (soubor má UTF-8 BOM).

Rychlý test přes curl (bez UI):

```bash
# 401 bez hesla
curl -i http://localhost:3001/admin/leads

# seznam s heslem
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/leads

# změna stavu
curl -X PATCH -H "x-admin-password: VASE_HESLO" -H "Content-Type: application/json" \
  -d '{"status":"contacted"}' http://localhost:3001/admin/leads/<ID>/status

# export CSV do souboru (celý seznam)
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/leads/export.csv -o leads.csv

# export CSV jen podle filtru (stejné filtry jako seznam: type/status/search)
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/leads/export.csv?type=final_cta" -o leads_final_cta.csv
```

## 6a. Admin panel — přehled objednávek prohlídek

Otevřete `http://localhost:8000/admin-bookings.html` (stejný princip jako
`admin-leads.html`: heslo v `sessionStorage`, filtry — tady navíc podle
`status` a `city`, plus hledání podle VIN/e-mailu/telefonu/jména/města).
Detailní modál umožňuje totéž jako u leadů: změnu stavu, interní
poznámku, smazání po `confirm()` — a stejně jako u leadů se detail při
každém otevření potvrdí čerstvým `GET /admin/bookings/:id`, ne jen
z mezipaměti seznamu. Tabulka i detail teď navíc zobrazují
**Zaplaceno** (`paidAt`) a v detailu i `paymentId` — vyplní se
automaticky, jakmile webhook spojený checkout označí za `paid` (viz
sekce «Связь оплаты» výše). Status/note/delete/export tím nejsou
nijak ovlivněny.

```bash
# 401 bez hesla
curl -i http://localhost:3001/admin/bookings

# seznam s heslem
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/bookings

# změna stavu
curl -X PATCH -H "x-admin-password: VASE_HESLO" -H "Content-Type: application/json" \
  -d '{"status":"inspector_assigned"}' http://localhost:3001/admin/bookings/<ID>/status

# export CSV do souboru
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/bookings/export.csv -o bookings.csv

# export CSV jen podle filtru (status/city/search — export vždy odpovídá tomu, co je v tabulce)
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/bookings/export.csv?city=Praha" -o bookings_praha.csv
```

`admin-leads.html`, `admin-bookings.html` a `admin-vin-checks.html` jsou
tři zcela oddělené stránky (vlastní JS soubory, sdílí jen `css/admin.css`
a stejné `ADMIN_PASSWORD`) — úprava jedné nemůže rozbít druhou. Nahoře
na každé je jednoduchá navigace mezi všemi třemi.

## 6b. Admin panel — VIN kontroly (read-only, kromě interní poznámky)

Otevřete `http://localhost:8000/admin-vin-checks.html`. Stejný princip
přihlášení jako u ostatních dvou stránek. Pořád **žádná změna stavu a
žádné mazání** — to zůstává mimo scope. Jen seznam, filtr podle
`riskLevel`, hledání podle VIN/ID/zdroje/jazyka, detail a CSV export.
Stránka viditelně připomíná, že jde o demo-výsledky (`DEMO` badge
v hlavičce i v tabulce, upozornění v detailu). Tabulka i detail teď
navíc zobrazují **Platba** (`paymentStatus`) a v detailu i `paidAt`/
`paymentId` — vyplní se, jakmile webhook spojený checkout označí za
`paid`. Pole `status` (vždy „completed“) tím zůstává nedotčené — jde
o dvě různé věci (dokončení kontroly vs. zaplacení).

**Jediná editace, která na této stránce existuje:** interní admin
poznámka (`internalNote`) — v detailu je textarea + tlačítko „Save
note“. Poznámka je jen pro interní použití administrátora (co ručně
zkontrolovat, jaké riziko bylo nalezeno, jestli kontaktovat klienta,
jestli je potřeba plnohodnotná zpráva) — **zákazník ji nikdy nevidí**,
nikde na veřejném webu se nezobrazuje. Stejně jako u leadů/bookingů/
plateb se detail při každém otevření potvrdí čerstvým
`GET /admin/vin-checks/:id`, ne jen z lokální mezipaměti seznamu.

```bash
# 401 bez hesla
curl -i http://localhost:3001/admin/vin-checks

# seznam s heslem
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/vin-checks

# filtr podle rizika
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/vin-checks?riskLevel=high"

# detail jedné kontroly
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/vin-checks/<ID>

# export CSV do souboru
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/vin-checks/export.csv -o vin-checks.csv

# export CSV jen podle filtru (riskLevel/search — export vždy odpovídá tomu, co je v tabulce)
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/vin-checks/export.csv?riskLevel=high" -o vin-checks_high.csv

# uložit interní poznámku
curl -X PATCH "http://localhost:3001/admin/vin-checks/<ID>/note" \
  -H "Content-Type: application/json" \
  -H "x-admin-password: VASE_HESLO" \
  -d '{"internalNote":"Manual review required before sending final report"}'
```

Poznámky k `PATCH /admin/vin-checks/:id/note`:

- odpověď je `{ "ok": true, "vinCheck": { ... } }` — pozor, klíč je
  `vinCheck`, ne `item` jako u ostatních PATCH endpointů (schválně,
  podle zadání tohoto kroku);
- `internalNote` musí být string, prázdný řetězec je v pořádku, ale
  **pole musí být přítomné** (chybějící `internalNote` → 400);
- limit je **5000 znaků** (u leads/bookings je to 3000 a překročení se
  tiše ořízne — tady je to schválně jinak: překročení je tvrdá chyba
  400, ne tiché oříznutí);
- žádné PATCH pro `status`, žádné DELETE pro vin-checks — pořád mimo
  scope, záměrně.

## 6c. Проверить email-уведомления

**Без реального SMTP (dev по умолчанию):** оставьте `EMAIL_ENABLED=false`
в `.env` — лиды/bookings/VIN-проверки сохраняются как обычно, письма не
уходят, backend не падает. Проверить это можно, отправив что угодно из
разделов 4/5a/5b и посмотрев на `email_logs`:

```bash
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/email-logs
```

**С реальным (но безопасным) SMTP для проверки:** используйте
одноразовый тестовый SMTP-сервис — например [Ethereal Email](https://ethereal.email/)
(создаёт временный ящик и SMTP-креды бесплатно, письма никуда реально
не уходят, только видны в веб-интерфейсе) или локальный SMTP-сервер типа
[`smtp-server`](https://www.npmjs.com/package/smtp-server) для полностью
офлайн-теста. Впишите полученные `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`
в `.env`, поставьте `EMAIL_ENABLED=true`, перезапустите backend и снова
отправьте lead/booking/VIN-проверку — в `email_logs` появятся записи со
статусом `sent`, а в ответе endpoint'а — `"email":{"adminEmailSent":true,...}`.

**Важно:** реальные SMTP-креды (даже от тестового сервиса) никогда не
должны попадать в `.env.example` или в архив проекта — только в
локальный `.env`, который не упаковывается.

## 6d. Admin panel — Email logy (read-only, kromě ručního review)

Otevřete `http://localhost:8000/admin-email-logs.html`. Stejný princip
jako `admin-vin-checks.html` — **žádné opakované odeslání, žádné
mazání**, to zůstává mimo scope. Filtry podle `entityType`, `status`,
přesné `entityId`, `reviewed`/`resolved` (viz níže), plus fulltextové
hledání podle e-mailu příjemce / předmětu / chybové zprávy / ID entity.
Detail zobrazí kompletní chybovou zprávu, i když je dlouhá (v tabulce je
jen zkrácený náhled). Stejně jako u ostatních čtyř admin stránek se
detail při každém otevření potvrdí čerstvým `GET /admin/email-logs/:id`,
ne jen z mezipaměti seznamu.

```bash
# 401 bez hesla
curl -i http://localhost:3001/admin/email-logs

# seznam s heslem
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/email-logs

# detail jednoho záznamu
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/email-logs/<ID>

# jen chyby
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/email-logs?status=failed"

# hledání
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/email-logs?search=example.com"
```

Tlačítko **Export CSV** na stránce stahuje soubor s aktuálně nastavenými
filtry (typ entity, stav, reviewed/resolved, ID entity, hledání) —
export tedy odpovídá tomu, co je zrovna vidět v tabulce. CSV obsahuje
pole `id, createdAt, entityType, entityId, recipientType,
recipientEmail, subject, status, errorMessage, reviewedAt, resolvedAt,
internalNote`, s BOM na začátku (kvůli diakritice v Excelu) a korektním
escapováním čárek/uvozovek/nových řádků — i v dlouhé `errorMessage`
a `internalNote`.

```bash
# export vč. filtru status=failed
curl "http://localhost:3001/admin/email-logs/export.csv?status=failed" \
  -H "x-admin-password: VASE_HESLO" \
  -o email_logs_failed.csv
```

Export je čistě ke čtení — žádné opakované odeslání (retry/resend) e-mailů
zatím neexistuje, to by byl samostatný krok.

### Ruční admin review (reviewed / resolved / internalNote)

Pro `failed`/`skipped` e-maily je občas potřeba poznamenat si, že už na
ně admin koukl a případně je i vyřešil — bez toho, aby to jakkoliv
měnilo skutečný výsledek odeslání (`status` zůstává navždy `sent`/
`failed`/`skipped`, to je fakt, ne názor admina).

```bash
# označit jako reviewed
curl -X PATCH "http://localhost:3001/admin/email-logs/<ID>/review" \
  -H "Content-Type: application/json" \
  -H "x-admin-password: VASE_HESLO" \
  -d '{"reviewed":true}'

# označit jako resolved + přidat poznámku (lze i najednou)
curl -X PATCH "http://localhost:3001/admin/email-logs/<ID>/review" \
  -H "Content-Type: application/json" \
  -H "x-admin-password: VASE_HESLO" \
  -d '{"resolved":true,"internalNote":"SMTP fixed 2026-09-10, resent manually via provider dashboard"}'

# zrušit reviewed/resolved
curl -X PATCH "http://localhost:3001/admin/email-logs/<ID>/review" \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"reviewed":false}'

# filtrovat podle stavu review
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/email-logs?reviewed=false&status=failed"
```

Chování `PATCH /admin/email-logs/:id/review`:

- odpověď je `{ "ok": true, "emailLog": { ... } }`;
- všechny tři pole (`reviewed`, `resolved`, `internalNote`) jsou
  nezávislá a volitelná, ale **aspoň jedno musí být přítomné** — prázdné
  `{}` je 400, ne no-op úspěch;
- `reviewed: true` nastaví `reviewedAt` na teď, ale **jen pokud ještě
  není nastaveno** — opakované `{"reviewed":true}` nepřepíše už
  existující timestamp (ověřeno v testech);
- `reviewed: false` timestamp vynuluje; stejná logika platí pro
  `resolved`/`resolvedAt`;
- `internalNote` — string, prázdný řetězec je platná hodnota (vymaže
  poznámku), limit 5000 znaků, chybějící pole v payloadu poznámku
  nemění (na rozdíl od prázdného řetězce, který ji vymaže).



Rotace/archivace `email_logs` zatím neexistuje — tabulka roste s každým
pokusem o odeslání (i přeskočeným), bez mazání.

## Známé limity: co pro email logy zatím chybí

- Jediný PATCH je `.../review` (reviewed/resolved/internalNote) —
  žádná změna `status` (to je fakt o odeslání, ne názor admina), žádné
  DELETE — záměrně (ochrana proti náhodnému „skrytí“ chyby smazáním
  záznamu).
- Žádná automatická rotace/archivace — pro reálný provoz bude potřeba
  periodicky staré záznamy mazat nebo exportovat a čistit.
- Žádné opakované odeslání (retry/resend) přímo z admin rozhraní —
  pokud e-mail selže, jediná cesta je opravit SMTP a nechat systém
  vytvořit novou příležitost (novým leadem/bookingem/VIN-checkem).

## Агенты и назначение ответственных

Бизнес-роли (не пользователи с логином — см. «Что это НЕ такое» ниже),
которым можно назначить lead/booking/vin_check/payment. Пять
фиксированных ролей:

| role | Отвечает за |
|---|---|
| `sales_agent` | новые leads, связь с клиентом, перевод к booking/payment |
| `booking_coordinator` | bookings, статус, фиксация оплаты, передача технику |
| `vin_analyst` | VIN-проверки, ручной review, internalNote |
| `payment_admin` | платежи, paid/cancelled/failed, связь с booking/vin_check |
| `admin_supervisor` | общий контроль, email logs, reviewed/resolved |

### Модель данных

Одна новая таблица `agents` (id/name/role/email/active/createdAt/updatedAt)
плюс одно новое поле `assignedAgentId TEXT` (nullable) в каждой из четырёх
уже существующих таблиц — `leads`, `bookings`, `vin_checks`, `payments`.
Осознанно **не** отдельная join-таблица `assignments` — проще запрашивать
(никаких JOIN в уже существующих list/detail роутах), проще тестировать,
и тот же паттерн, что уже применялся для `paidAt`/`internalNote` и т. д.
Старые записи без `assignedAgentId` не ломаются — читаются как
unassigned.

### CRUD агентов

```bash
# создать агента
curl -X POST http://localhost:3001/admin/agents \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"name":"Jana Nováková","role":"sales_agent","email":"jana@nexium.cz"}'

# список (фильtry: role, active=true/false, search по jménu/e-mailu)
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/agents?role=sales_agent"

# detail
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/agents/<ID>

# úprava (libovolná podmnožina name/role/email/active)
curl -X PATCH http://localhost:3001/admin/agents/<ID> \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"role":"booking_coordinator"}'

# soft deactivate — přes stejný endpoint, žádné DELETE
curl -X PATCH http://localhost:3001/admin/agents/<ID> \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"active":false}'
```

Žádné fyzické mazání agenta — deaktivovaný agent zůstává v historii
přiřazení čitelný (jeho jméno se stále zobrazí, jen s badge „inactive“).

### Přiřazení entity k agentovi

Stejný vzor na všech čtyřech entitách — `PATCH .../assign` s
`{ "assignedAgentId": "agent_..." }`, nebo `null` pro zrušení přiřazení:

```bash
curl -X PATCH http://localhost:3001/admin/leads/<ID>/assign \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"assignedAgentId":"agent_xxx"}'

curl -X PATCH http://localhost:3001/admin/bookings/<ID>/assign \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"assignedAgentId":"agent_xxx"}'

curl -X PATCH http://localhost:3001/admin/vin-checks/<ID>/assign \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"assignedAgentId":"agent_xxx"}'

curl -X PATCH http://localhost:3001/admin/payments/<ID>/assign \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"assignedAgentId":null}'
```

Přiřazení k neexistujícímu `assignedAgentId` je `400`, ne tichá chyba.

### admin-agents.html

Otevřete `http://localhost:8000/admin-agents.html` — vytvoření agenta,
seznam s filtry (role/active/search), detail s editací (jméno/role/
e-mail/active). Stejné `ADMIN_PASSWORD` jako všude jinde. Ostatní čtyři
admin stránky (leads/bookings/vin-checks/payments) mají v detailu nový
dropdown „Přiřazený agent“ a v tabulce nový sloupec „Agent“ — uloží se
společně s existujícím Save tlačítkem (žádné nové tlačítko navíc).

### Co to NENÍ

Agenti jsou business-data (evidence + přiřazení), **ne** multi-user
login systém. Pořád jediné `ADMIN_PASSWORD` pro celý admin — kdokoliv
se přihlásí, vidí a upravuje všechno, bez ohledu na to, komu je co
přiřazeno. Žádné role-based access control, žádné notifikace agentům
při přiřazení (zatím) — viz limity níže.

## Reports — workflow pro placené VIN reporty a manual review

Operační evidence pro to, co se děje **po** zaplacení — ne delivery
systém. Report se admin-team interně posouvá stavy, dokud není hotový;
jak se hotový report dostane k zákazníkovi je **samostatný, zatím
neimplementovaný krok** (žádná veřejná stránka reportu, žádný email
s obsahem reportu na tomto kroku).

### Stavy

```
created → in_review → draft_ready → report_ready → report_sent → completed
                                                          ↳ cancelled (kdykoliv)
```

Každý přechod se zapisuje do `report_status_history` (starý stav, nový
stav, volitelný důvod, čas) — kompletní audit trail, vidět v detailu na
`admin-reports.html`.

### Jak report vznikne

**Žádný veřejný endpoint pro vytvoření reportu neexistuje.** Report se
vytváří automaticky uvnitř `applyWebhookEvent()` (`paymentService.js`),
hned po tom, co webhook označí platbu za `paid`:

| productCode | entityType | Vytvoří se report? |
|---|---|---|
| `vin_basic_report` | `vin_check` | Ano — `reportType=vin_basic_report`, `entityId` = ID VIN kontroly, `language` převzato z VIN kontroly |
| `manual_car_review` | `manual_review` | Ano — `reportType=manual_car_review`, `entityId` = ID platby (manual_review nemá vlastní entitu, takže se použije platba jako stabilní kotva) |
| `inspection_booking_deposit` | `booking` | **Ne, záměrně** — viz níže |

**Proč `inspection_booking_deposit` nevytváří `inspection_report`
automaticky:** na rozdíl od VIN reportu (vygenerovaný okamžitě) nebo
manual review (placený produkt JE ten review sám), obsah inspekčního
reportu v momentě zaplacení zálohy ještě fyzicky neexistuje — technik
musí vozidlo nejdřív reálně prohlédnout. Vytvořit prázdný report-řádek
by jen zavádělo admin workflow (tvářilo by se to jako "report_ready"
data, která nikdo nevytvořil). Nechané na budoucí krok, až bude jasný
konkrétní trigger ("inspekce proběhla").

### Idempotency

Kontroluje se přes `getReportByEntity(entityType, entityId)` — pokud už
pro danou dvojici report existuje, druhý se nevytvoří. Opakovaný webhook
(stejná session, doručena podruhé) je díky tomu bezpečný — stejně jako
u samotné platby (`applyWebhookEvent`'s vlastní idempotency guard tohle
navíc zastaví ještě dřív, protože druhý `payment.paid` na už-zaplacenou
platbu je no-op sám o sobě).

**Jak ověřit:** zavolejte stejný mock webhook dvakrát (viz „Протестировать
mock webhook" výše), pak `GET /admin/reports?entityId=<ID>` — `total`
musí zůstat `1`.

### Tabulky

`reports` — id/entityType/entityId/status/reportType/title/summary/
verdict/riskLevel/score/language/customerEmail/internalNote/createdAt/
updatedAt/draftReadyAt/reportReadyAt/sentAt/completedAt/cancelledAt.

`report_status_history` — id/reportId/oldStatus/newStatus/reason/createdAt.

### Admin endpoints

```bash
# 401 bez hesla
curl -i http://localhost:3001/admin/reports

# seznam s filtry (status/reportType/entityType/entityId/customerEmail/search/limit/offset)
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/reports?status=in_review"

# detail
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/reports/<ID>

# historie stavů
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/reports/<ID>/history

# změna stavu (reason nepovinný)
curl -X PATCH http://localhost:3001/admin/reports/<ID>/status \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"status":"in_review","reason":"Analyst picked it up"}'

# interní poznámka
curl -X PATCH http://localhost:3001/admin/reports/<ID>/note \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"internalNote":"Double-checked manually"}'

# obsah reportu (title/summary/verdict/riskLevel/score — libovolná podmnožina)
curl -X PATCH http://localhost:3001/admin/reports/<ID>/summary \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"verdict":"Good condition","riskLevel":"low","score":85}'

# export CSV (stejné filtry jako seznam, bez ohledu na limit=200 u seznamu — CSV vrací vše)
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/reports/export.csv -o reports.csv
```

### admin-reports.html

Šestá nová admin stránka celkem (`http://localhost:8000/admin-reports.html`,
stejné `ADMIN_PASSWORD`). Detail je rozdělený do čtyř záložek — **Summary**
(změna stavu + důvod, blok „Doručení klientovi" — viz «Secure report
delivery» níže, title/summary/verdict/riskLevel/score, interní
poznámka), **Sections** (manual report builder, viz níže), **Preview**
(interní náhled) a **History** (read-only historie přechodů). Detail se
při každém otevření potvrdí čerstvým GET, stejně jako u ostatních šesti
admin stránek.

## Manual report builder — sekce reportu

Než se k projektu připojí AI jako pomocník (budoucí krok, záměrně teď
ne), musí být reálně možné sestavit kvalitní report **ručně**. Report má
vlastní sadu textových sekcí (`report_sections`), které admin postupně
vyplňuje — každá s vlastním title/content, vlastním pořadím a vlastním
Save tlačítkem.

### Jaké sekce se vytváří automaticky

Při vytvoření reportu (viz sekce «Reports» výše — automaticky po
`payment.paid`) se rovnou založí defaultní sada sekcí podle `reportType`:

| reportType | Sekce (v tomto pořadí) |
|---|---|
| `vin_basic_report` | overview, vehicle_data, vin_result, odometer_risk, accident_risk, seller_questions, physical_inspection_recommendations, final_verdict, disclaimer (9) |
| `manual_car_review` | overview, listing_risks, seller_questions, price_negotiation, physical_inspection_recommendations, final_verdict, disclaimer (7) |

Obsah každé sekce začíná jako prázdný řetězec (nikdy `null`) — admin je
postupně vyplňuje ve záložce **Sections**.

### Endpoints

```bash
# seznam sekcí reportu
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/reports/<ID>/sections

# úprava jedné sekce (podle jejího vlastního id, ne podle reportId+sectionKey)
curl -X PATCH http://localhost:3001/admin/report-sections/<SECTION_ID> \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"title":"Přehled","content":"Vozidlo zkontrolováno, VIN ověřen jako pravý."}'

# změna pořadí — orderedIds musí obsahovat KAŽDÉ id sekcí tohoto reportu
# přesně jednou (částečný seznam je 400, ne tichý no-op)
curl -X PATCH http://localhost:3001/admin/reports/<ID>/sections/reorder \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"orderedIds":["reportsection_a","reportsection_b","..."]}'

# reset na výchozí — SMAŽE všechny stávající sekce a založí defaultní
# sadu znovu od nuly (dosavadní obsah se nenávratně ztratí; admin UI se
# ptá přes potvrzovací dialog, než tohle zavolá)
curl -X POST http://localhost:3001/admin/reports/<ID>/sections/reset-defaults \
  -H "x-admin-password: VASE_HESLO"

# admin-only preview — NE veřejná stránka, viz níže
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/reports/<ID>/preview
```

### Jak funguje preview

`GET /admin/reports/:id/preview` vrací `report` + `sections` (seřazené
podle `sortOrder`) v jednom volání — admin UI z toho postaví vizuální
náhled, který vypadá jako skutečný report (nadpis s NEXIUM, report ID,
datum, typ, propojená entita, skóre/riziko/verdikt, jednotlivé sekce,
disclaimer na konci, a varování, pokud jsou nějaké sekce ještě
nevyplněné). **Toto NENÍ veřejná stránka** — vyžaduje `ADMIN_PASSWORD`
stejně jako všechno ostatní na tomto routeru, a doručení hotového
reportu zákazníkovi zůstává samostatný, zatím neimplementovaný krok
(žádné URL, které by šlo poslat zákazníkovi, nikde neexistuje).

### Validace přechodů stavu (`draft_ready` / `report_ready`)

Měkké business pravidlo, ne DB constraint — kontroluje se při
`PATCH /admin/reports/:id/status`, před samotným přechodem:

- **`draft_ready`** — sekce `overview`, `final_verdict` a `disclaimer`
  musí mít neprázdný (trimmed) obsah. Chybí-li něco, vrací se `400` se
  seznamem konkrétních chybějících sekcí.
- **`report_ready`** — **úplně všechny** sekce, které report aktuálně
  má, musí mít neprázdný obsah — celý report by měl být čitelný, než se
  označí za hotový.
- Jakýkoliv jiný cílový stav (`created`, `in_review`, `report_sent`,
  `completed`, `cancelled`) — bez kontroly sekcí, přechod projde vždy.

### Co dál (záměrně mimo tento krok)

AI jako pomocník při psaní sekcí a PDF export — obojí samostatné budoucí
kroky. Veřejná stránka reportu (delivery) je od tohoto kroku **hotová**
— viz sekce «Secure report delivery» níže.

### Email

Při vytvoření reportu jde **jen interní admin notifikace** (stejný
best-effort vzor jako `sendPaymentPaidEmail` — chyba v odeslání nikdy
nezastaví vytvoření reportu). Žádný email s obsahem reportu zákazníkovi
při vytvoření — ten jde teprve při explicitním „Send to customer“, viz
níže.

## Secure report delivery — soukromý odkaz na report bez loginu

Jakmile je report `report_ready`, admin ho může zpřístupnit zákazníkovi
přes **soukromý odkaz s tokenem** — žádný login, žádný účet, jen
`report.html?token=...`. Kdokoliv s tím přesným odkazem report vidí;
nikdo jiný ho nenajde ani neuhodne.

### Bezpečnost tokenu

- **32 bajtů kryptograficky náhodných dat** (`crypto.randomBytes(32)`),
  hex-encoded = 64 znaků. Neuhodnutelné brute-force útokem.
- Token se nikdy nezadává ručně — jen `POST .../public-token`
  (backend) ho generuje.
- **V seznamu (`GET /admin/reports`) se nikdy nevrací celý token** —
  jen `publicTokenPreview` (prvních 8 znaků + `…`). Celý token vrací
  jen `GET /admin/reports/:id` — jednorázový, cílený dotaz na konkrétní
  report, ne hromadný seznam. Stejný princip v `admin-reports.html`:
  tabulka ukazuje jen zkrácený náhled, plný token je dostupný (pro
  Copy link) až po otevření detailu.
- **Revoke nemaže hodnotu tokenu** — jen nastaví
  `publicTokenRevokedAt`. Starý odkaz pak vrací `410 Gone`, ne tichou
  chybu — a `GET /admin/reports/:id` pořád ukáže, že token existoval
  (audit trail), jen je zrušený.
- Backend nemá žádný access-log middleware, který by zapisoval plné
  URL požadavků (viz `server.js`) — token se tak nikde v serverových
  logách automaticky nezaznamenává. Frontend
  stránka `report.html?token=...` ale token pořád nese v URL adresního
  řádku prohlížeče — to je vlastní chování prohlížeče/prohlížečové
  historie, mimo kontrolu backendu.

### Public endpoint

```bash
# funguje bez x-admin-password — jediné "ověření" je znalost přesného tokenu
curl http://localhost:3001/reports/public/<TOKEN>
```

Vrací **jen** tato pole — schválně vybraný allowlist, ne "celý řádek
minus pár polí":

```json
{
  "ok": true,
  "report": {
    "id": "...", "reportType": "...", "title": "...", "summary": "...",
    "verdict": "...", "riskLevel": "...", "score": 85, "status": "report_ready",
    "createdAt": "...", "completedAt": null
  },
  "sections": [{ "sectionKey": "...", "title": "...", "content": "...", "sortOrder": 0 }]
}
```

**Nikdy nevrací:** `internalNote`, `customerEmail`, `publicToken`
samotný, `entityId`/`entityType` (interní reference), historii stavů
(`report_status_history`), ani nic souvisejícího s platbou — `reports`
tahle pole ani nemá, ale stojí za to říct to explicitně.

Chování podle stavu:

| Situace | Odpověď |
|---|---|
| Token neexistuje | `404 NOT_FOUND` |
| Token existuje, ale byl zrušen (`publicTokenRevokedAt` je nastaven) | `410 GONE` |
| Token existuje, nezrušen, ale report **není** `report_ready`/`report_sent`/`completed` | `404 NOT_FOUND` (schválně stejná odpověď jako "neexistuje" — endpoint nikdy nepotvrzuje, že token k něčemu patří, dokud report opravdu není hotový) |
| Token existuje, nezrušen, report je ready/sent/completed | `200` s daty výše |

### Admin endpoints

```bash
# vygenerovat (nebo znovu vygenerovat) veřejný token
curl -X POST http://localhost:3001/admin/reports/<ID>/public-token \
  -H "x-admin-password: VASE_HESLO"
# -> { "ok": true, "report": {...}, "publicLink": "http://.../report.html?token=..." }

# zrušit aktuální token
curl -X DELETE http://localhost:3001/admin/reports/<ID>/public-token \
  -H "x-admin-password: VASE_HESLO"

# poslat zákazníkovi e-mailem
curl -X POST http://localhost:3001/admin/reports/<ID>/send-to-customer \
  -H "x-admin-password: VASE_HESLO"
```

### Jak funguje `send-to-customer`

1. Report musí být `report_ready` — jinak `400`.
2. Musí mít `customerEmail` — jinak `400`.
3. Použije existující platný token, pokud je — jinak (žádný token nebo
   zrušený) vygeneruje nový, aby odeslaný odkaz vždy fungoval.
4. Pošle `userReportReadyEmail` (předmět „NEXIUM — your report is
   ready", odkaz, upozornění že report snižuje riziko ale negarantuje
   bezvadnost vozidla).
5. **Status se na `report_sent` přepne jen tehdy, když e-mail opravdu
   odešel** (`EMAIL_ENABLED=true` a SMTP uspěje). Když `EMAIL_ENABLED=false`
   nebo SMTP selže — odkaz se i tak vygeneruje a vrátí v odpovědi
   (`publicLink`), aby ho šlo poslat ručně, ale `status` zůstává
   `report_ready` a `sentAt`/`deliveredAt` se nenastaví. Odpověď vždy
   obsahuje `emailSent: true/false` a srozumitelnou `message` — žádné
   tiché předstírání úspěchu.
6. Při úspěchu se `sentAt` i `deliveredAt` nastaví ve stejný okamžik
   (v tomhle kroku "doručeno" = "e-mail odeslán", ne "zákazník report
   otevřel" — to druhé by vyžadovalo sledovat otevření veřejné stránky,
   což tenhle krok záměrně nedělá).

### admin-reports.html — nový blok „Doručení klientovi“

V záložce Summary: zkrácený náhled tokenu, `sentAt`/`deliveredAt`,
tlačítka Generate/Copy/Revoke a Send to customer. „Copy link" kopíruje
skutečný odkaz do schránky (Clipboard API, s fallbackem přes
`execCommand` pro starší prohlížeče) — na obrazovce/ve screenshotu se
ale pořád ukazuje jen zkrácený náhled.

### Co je záměrně mimo scope tohoto kroku

Žádný login/účet pro zákazníka — token je jediné "ověření". Žádné
sledování, jestli/kdy zákazník odkaz otevřel (`deliveredAt` se
nastavuje při odeslání e-mailu, ne při zobrazení stránky). Žádné
omezení počtu zobrazení tokenu — dokud není zrušen, funguje libovolně
mnohokrát. Žádný automatický reálný SMTP test v tomhle prostředí (není
tu síťový přístup) — ověřeno jen se `SMTP_HOST` směřujícím na
neexistující server (očekávané selhání, korektně zpracované), ne s
opravdu doručeným e-mailem.

## AI orchestrator foundation

Základ: registr agentů, orchestrátor, logging každého běhu, bezpečnostní
limity, a hlavně **povinné human review** předtím, než cokoliv z AI
výstupu kamkoliv jde. Dva providery skutečně fungují: `mock`
(deterministický, offline, bez nákladů) a **`openai`** (skutečné
volání OpenAI API — viz «GPT API readiness» níže pro plné zapojení,
error handling a jak otestovat).

### 14 agentů (5 report + 9 business), architektura pro dalších 5 plánovaných

Registr (`backend/ai/agentRegistry.js`) obsahuje 5 report-kind agentů
(`listing_analysis`, `risk_scoring`, `report_writer`, `buyer_advisor`,
`vin_risk_explanation`) + 9 business-kind agentů (viz «AI agents — wave
2/3» níže) — dohromady pokrývají celý požadovaný katalog pro řízení
firmy. Přidání dalšího agenta (z 5 zatím plánovaných, viz «GPT API
readiness»'s tabulka) je jeden nový záznam v registru + jeden prompt
builder, ne změna architektury.

### Proč AI výstup nejde nikam automaticky

- **Žádný agent nezapisuje do `report_sections` automaticky** — výstup
  se jen uloží do `ai_agent_runs`, admin ho ručně zkopíruje do sekce,
  pokud se mu líbí (přes „Run AI helper" odkaz z `admin-reports.html`,
  otevře se `admin-ai-runs.html` na kartě, admin obsah přečte a sám
  vloží).
- **`requiresHumanReview` je natvrdo `true` u každého běhu** — env
  proměnná `AI_REQUIRE_HUMAN_REVIEW` existuje (viz `.env.example`), ale
  **nevypíná** review, ani když je `false`. Tohle je záměrné: tenhle
  krok nemá žádný mechanismus, který by rozlišil "tenhle typ výstupu je
  dost bezpečný na to, aby přeskočil review" od "tenhle není" — takže
  dokud takový mechanismus neexistuje, bezpečnější je review nikdy
  nevypínat, bez ohledu na konfiguraci.
- **Report delivery (`send-to-customer`) se AI výstupu vůbec nedotýká**
  — ten dál posílá jen to, co je ručně v `report_sections`/`reports`
  polích, přes existující workflow (viz «Secure report delivery» výše).
  Nic v tomhle kroku nemění tuhle logiku.
- Každý výstup nese `disclaimer` pole (`backend/ai/safety/disclaimers.js`)
  — explicitně říká, že jde o needěditovaný AI draft, ne ověřený obsah.

### Env

```bash
AI_ENABLED=false          # master switch — stejný vzor jako PAYMENTS_ENABLED/EMAIL_ENABLED
AI_PROVIDER=mock          # mock (default, zdarma) | openai (skutečné volání, viz "GPT API readiness") | anthropic (přijme se, ale isConfigured()=false)
AI_MODEL=
AI_API_KEY=                # jen pro AI_PROVIDER mimo openai/mock — nikdy necommitovat
AI_MAX_INPUT_CHARS=20000  # tvrdý limit na input (JSON-stringified), hlavní cost control
AI_REQUIRE_HUMAN_REVIEW=true  # viz "Proč AI výstup nejde nikam automaticky" výše — tahle
                                # proměnná review nevypíná, i kdyby byla false
```

### Mock provider

`backend/ai/aiClient.js` — deterministický: stejný `agentName` + stejný
input vždy dá stejný `prompt-hash` (sha256 promptu, prvních 12 znaků) v
textu výstupu — ověřitelné bez skutečného modelu. Žádné síťové volání,
žádné náklady, `estimatedCost` je jen fiktivní ukázkové číslo označené
`(mock estimate)`. Tohle je automatický fallback — kdykoliv
`AI_PROVIDER≠openai`, nebo `openai` není nakonfigurovaný (chybí klíč
nebo `AI_MONTHLY_BUDGET_LIMIT`), agent prostě neběží vůbec (jasná
`PROVIDER_NOT_CONFIGURED` chyba) — mock se nikdy nezvolí automaticky
jako tichý fallback za nefunkční reálný provider, výběr providera je
vždy explicitní přes `AI_PROVIDER`.

**`openai` je implementovaný a otestovaný proti skutečnému
`api.openai.com`** (viz «GPT API readiness» níže pro plné zapojení,
error handling, cenový odhad a jak otestovat). `anthropic` (nebo
jakýkoliv jiný název) se přijme bez pádu backendu, ale `isConfigured()`
vrátí `false` — `POST /admin/ai/run` odpoví `503 PROVIDER_NOT_CONFIGURED`.

### Bezpečnostní limity (`backend/ai/safety/`)

- **Velikost inputu** — tvrdý strop `AI_MAX_INPUT_CHARS`, kontrolovaný
  PŘED jakýmkoliv voláním providera (hlavní cost control — reálný
  provider účtuje zhruba podle velikosti vstupu).
- **Detekce podezřelých secrets** — pokud input vypadá jako obsahuje
  API klíč / Stripe klíč / PEM privátní klíč, request se rovnou odmítne
  (400), i když se v tomhle kroku nikam neposílá.
- **Tvar inputu** — musí být plain JSON object, nikdy pole/string/číslo.

### Tabulky

`ai_agent_runs` — id/agentName/entityType/entityId/status (`running`→
`completed`/`failed`)/inputJson/outputJson/errorMessage/model/provider/
estimatedCost/requiresHumanReview/reviewedAt/approvedAt/rejectedAt/
reviewNote/createdAt/updatedAt.

`ai_prompts` — statický template textu promptu pro každého agenta,
verzovaný (`promptVersion`, zatím vždy `"v1"`). Seedne se automaticky
při startu backendu (`seedPromptsIfNeeded()` v `orchestrator.js`) — 5
řádků, jeden na agenta, `active=1`. Zatím žádné API pro editaci
promptů přes UI — templaty žijí v `backend/ai/prompts/reportPrompts.js`,
tabulka je jen auditní záznam "jaký prompt byl aktivní kdy".

### Endpoints

```bash
# spustit agenta
curl -X POST http://localhost:3001/admin/ai/run \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"agentName":"listing_analysis","entityType":"report","entityId":"report_xxx","input":{"price":150000}}'

# seznam (filtry: agentName/status/entityType/entityId/search/limit/offset)
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/ai/runs?status=completed"

# detail (input/output JSON v plném znění)
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/ai/runs/<ID>

# human review
curl -X PATCH http://localhost:3001/admin/ai/runs/<ID>/review \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"approved":true,"reviewNote":"Used as inspiration for the section"}'

# export CSV (bez inputJson/outputJson — viz níže)
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/ai/runs/export.csv -o ai-runs.csv
```

CSV export schválně neobsahuje `inputJson`/`outputJson` — až
20000+ znaků na buňku by udělalo tabulku nečitelnou; plný obsah je v
detailu na `admin-ai-runs.html`.

### admin-ai-runs.html

Osmá admin stránka. Seznam s filtry (agent/stav/typ entity/hledání),
detail s plným input/output JSON, tlačítka Approve/Reject s volitelnou
poznámkou. Sloupec „Review" v tabulce ukazuje `pending`/`approved`/
`rejected` odvozené z `approvedAt`/`rejectedAt` (ne samostatné pole).

### Integrace s report builderem

`admin-reports.html` → záložka Sections → panel „AI helper" přímo v
záložce: vybrat agenta, spustit, vidět structured JSON výstup,
Approve/Reject, a teprve po Approve tlačítko „Apply to report" (viz
«AI agents — wave 1» níže pro přesnou mapu, co se kam zapíše). Odkaz
„Celá historie běhů ↗" otevře `admin-ai-runs.html` přefiltrováno na
tenhle report. Report builder samotný (sekce, validace, preview,
delivery) se tímto krokem nemění — AI panel je čistě navíc.

## AI agents — wave 1

Pět zaregistrovaných agentů z minulého kroku teď skutečně něco dělají —
pořád jen přes `AI_PROVIDER=mock`, ale s realistickým, deterministickým,
**strukturovaným JSON výstupem** přesně podle specifikace níže, ne jen
placeholder textem jako předtím.

### Jak se sestavuje input agenta

Když admin klikne „Run agent" v `admin-reports.html` (bez ručního
zadávání JSON), backend si sám sestaví kontext přes
`backend/ai/reportContext.js`:

- report's vlastní pole (reportType, status, title, summary, verdict,
  riskLevel, score, language) — **bez `internalNote`**;
- všechny sekce reportu (sectionKey/title/content) — tak agent vidí, co
  už je napsané;
- pokud `entityType=vin_check`: připojená VIN kontrola (vin, year,
  mileage, accidents, owners, odometerRisk, verdictKey, riskLevel,
  score, **`isDemoResult`**) — bez `internalNote`;
- pokud `entityType=booking`: připojená objednávka (vin, listingUrl,
  city, message) — bez internalNote/email/telefonu/jména (PII);
- propojené platby (productCode, amount, currency, status) — nikdy
  customerEmail ani provider session/payment id.

`isDemoResult` je klíčové — každý prompt (viz
`backend/ai/prompts/reportPrompts.js`) instruuje model, aby demo VIN
data nikdy nevydával za oficiální ověřený report. Mock provider tohle
respektuje doslova — viz `vin_risk_explanation`'s `limitations` pole
níže.

### Output každého agenta (přesná JSON schéma)

Vynucováno na dvou místech: prompt sám o sobě instruuje model vrátit
přesně tenhle tvar, a `backend/ai/safety/aiGuards.js`'s
`validateAgentOutputShape()` kontroluje výstup providera PO volání —
pokud chybí povinné pole, run skončí jako `failed` s jasnou chybou
(`INVALID_OUTPUT`), ne tichým přijetím pokažených dat.

```
listing_analysis:      { redFlags[], missingInfo[], sellerQuestions[], confidence, summary }
risk_scoring:           { score (0-100), riskLevel, riskFactors[], protectiveFactors[], explanation }
report_writer:          { sections[{sectionKey,title,content}], summary, verdict }
buyer_advisor:           { recommendation, nextSteps[], negotiationPoints[], questionsForSeller[] }
vin_risk_explanation:    { vinSummary, riskExplanation, limitations[] }
```

Disclaimer text (`backend/ai/safety/disclaimers.js`) se **nevkládá do**
téhle striktní schémy — vrací se jako samostatné pole `disclaimer` na
úrovni API odpovědi (`POST /admin/ai/run`, `GET /admin/ai/runs/:id`),
aby schéma zůstala čistá a přesně mapovatelná při apply.

### Mock provider — realistický, ne jen placeholder

`backend/ai/aiClient.js` — každý agent má vlastní deterministický
generátor, který **skutečně čte** pole z kontextu (např. `risk_scoring`
reaguje na `vinCheck.odometerRisk`/`accidents`, `report_writer` navrhuje
obsah jen pro sekce, které na reportu opravdu existují a jsou
prázdné). Stejný input vždy dá byte-identický JSON výstup — ověřeno
testem.

### Apply to report — jediné místo, kudy AI výstup může do reportu

`backend/ai/applyToReport.js` + `POST /admin/ai/runs/:id/apply`. Endpoint
**odmítne** cokoliv, co není `completed` run s nastaveným `approvedAt`
— nikdy zamítnutý, nikdy dosud neschválený run, bez ohledu na to, co
request žádá.

| Agent | Kam se zapíše |
|---|---|
| `report_writer` | **Přepíše** obsah sekcí podle `sectionKey` (agent je navrhl od nuly) + `reports.summary`/`reports.verdict` |
| `risk_scoring` | Nastaví `reports.score`/`reports.riskLevel` |
| `buyer_advisor` | **Připojí** (nepřepíše) k sekcím `seller_questions` a `final_verdict` |
| `listing_analysis` | **Připojí** k sekci `listing_risks` |
| `vin_risk_explanation` | **Připojí** k sekci `vin_result` |

„Připojí" = ke stávajícímu obsahu sekce se přidá nový blok označený
`[AI-drafted, ...— reviewed and approved by admin before being added]`
— admin vidí, že tahle část přišla z AI, i po sloučení s vlastním textem.

**Pokud report nemá cílovou sekci** (např. `vin_basic_report` nemá
`listing_risks`), apply tenhle konkrétní kus přeskočí — `applied: false`
s důvodem — a pokračuje s ostatními poli. Nikdy nespadne, vrací vždy
kompletní seznam co se aplikovalo a co ne.

### Real provider readiness

Stejná honest situace jako Stripe/SMTP na předchozích krocích — v tomhle
prostředí není síťový přístup k `api.openai.com`/`api.anthropic.com`.
`AI_PROVIDER=openai`/`anthropic` se přijme, `isConfigured()` vrátí
`false`, `POST /admin/ai/run` odpoví `503 PROVIDER_NOT_CONFIGURED`,
backend nespadne. Až se reálný provider přidá: stejné `{ system, user }`
prompt rozhraní, požádat o JSON mode, naparsovat odpověď do stejného
tvaru `{ output, estimatedCost, model }` jako mock provider vrací —
`validateAgentOutputShape()` pak funguje identicky pro obě.

### Limitations

Žádná fotoanalýza. Žádné reálné VIN API. AI nikdy nic neposílá
zákazníkovi automaticky (viz «Secure report delivery» výše — send-to-
customer se AI výstupu vůbec nedotýká). `AI_REQUIRE_HUMAN_REVIEW`
review nikdy nevypíná (viz «AI orchestrator foundation» výše).
Mock výstup je psaný anglicky bez ohledu na `report.language` — reálný
provider by tohle respektoval, mock v tomhle kroku ne (mimo scope).

## AI agents — wave 2/3 (business agenti)

Devět agentů mimo report workflow — 4 z původního kroku (CRM, B2B
prodej, support, operace kolem plateb) + 5 nových, které dohromady
pokrývají celý požadovaný katalog pro řízení firmy (Lead Qualification /
VIN Report [= wave-1 `vin_risk_explanation`] / Booking Coordinator /
Payment Control [= `operations_payment`] / Email Support [= `support`,
teď i pro `email_log`] / Admin Operations / Revenue Share / Business
Growth). Architektonicky jiná kategorie než wave 1: **negenerují
ai_agent_runs a nemají "apply" krok** — místo toho každý běh rovnou
vytvoří jeden nebo víc `agent_tasks` řádků, a stav tasku samotného
(`open → reviewed → completed/dismissed`) JE ten human-review
mechanismus.

### Co AI smí a nesmí (nejdůležitější část tohohle kroku)

- **Nikdy nic neposílá** — `suggestedMessage` je vždy jen draft text v
  `agent_tasks`, žádný SMTP/notifikační kód se ho ani nedotkne.
- **Nikdy nemění stav platby** ani žádné jiné entity — `operations_payment`
  agent výslovně jen navrhuje, co zkontrolovat, nikdy sám nic nepřepisuje.
- **Nikdy nic nemaže.**
- **Nikdy klientovi nic neslibuje** — každý prompt
  (`backend/ai/prompts/businessPrompts.js`) má stejné tvrdé pravidlo:
  žádná cena, sleva, termín ani právní záruka jménem firmy. Support
  agent to demonstruje doslova — mock výstup říká „we don't have a
  guaranteed timeline to share yet", ne opak.
- Jediné, co tenhle krok skutečně dělá: **navrhuje** akci a text pro
  admina, který sám rozhodne, jestli/jak to použije.

### 9 agentů

| Agent | entityTypes | Co dělá |
|---|---|---|
| `crm_follow_up` | lead, booking | Navrhne další krok + draft follow-up zprávy |
| `b2b_sales` | lead | Osnova nabídky + call script pro dealer/inspector lead |
| `support` (**Email Support Agent**) | lead, booking, vin_check, payment, **email_log** | Draft vysvětlení stavu / follow-up e-mailu, bez právních záruk — nikdy nic samo neodešle |
| `operations_payment` (**Payment Control Agent**) | payment | Co zkontrolovat u failed/cancelled/paid platby — nikdy nemění stav |
| `lead_qualification` (**Lead Qualification Agent**) | lead | Kontrola úplnosti dat + odhad urgence + návrh dalšího kroku |
| `booking_coordinator_agent` (**Booking Coordinator Agent**) | booking | Checklist před přiřazením technika — nikdy sám nepřiřazuje |
| `admin_operations` (**Admin Operations Agent**) | dashboard | Denní souhrn napříč leads/bookings/vin_checks/payments/email_logs — jen agregované počty, žádné PII |
| `revenue_share_agent` (**Revenue Share Agent**) | revenue_share | Transparentní, read-only vysvětlení revenue-share výpočtu za měsíc — viz «Revenue-share 20%» níže |
| `business_growth` (**Business Growth Agent**) | dashboard | Návrhy na růst/konverzi jako scénáře s předpoklady, nikdy garantovaná prognóza |

`vin_risk_explanation` (**VIN Report Agent**) zůstává ve wave 1 výše —
používá VIN check výsledek a nikdy si nevymýšlí data, která v něm nejsou.

### Sběr kontextu (`backend/ai/businessContext.js`)

Na rozdíl od `reportContext.js` (wave 1) tady **`contactName` je
součástí kontextu** — tihle agenti přímo draftují zprávu adresovanou
konkrétní osobě, takže jméno pro personalizaci dává smysl. Pořád ale
bez `email`/`phone` (nejsou potřeba k draftu textu, jen k jeho reálnému
odeslání, což zůstává čistě na adminovi) a bez `internalNote`.

Dva entityTypes nemají žádnou konkrétní entitu k načtení — `entityId` je
tam jen popisek, ne skutečné ID:

- **`dashboard`** (pro `admin_operations`/`business_growth`) — `entityId`
  může být cokoliv (např. „today"). Kontext je vždy živý agregát za
  posledních 7 dní (`newLeadsCount`, `bookingsNeedingActionCount`,
  `failedPaymentsCount`, `failedEmailsCount`, `pendingVinChecksCount`, …)
  — **nikdy** jméno/e-mail/telefon konkrétního záznamu, jen počty.
- **`revenue_share`** (pro `revenue_share_agent`) — `entityId` musí být
  `"YYYY-MM"` (např. `"2026-09"`); jiný formát vrátí validační chybu.
  Kontext je čistě READ-ONLY — čte existující `revenue_share_ledger`/
  `monthly_payouts` (přes `backend/revenueShare/revenueShareService.js`),
  nikdy nic nepočítá ani nezapisuje.

### Tabulka `agent_tasks`

`id`/`agentName`/`entityType`/`entityId`/`taskType`/`title`/
`description`/`suggestedAction`/`suggestedMessage`/`status`
(`open`→`reviewed`→`completed`/`dismissed`)/`createdAt`/`updatedAt`/
`reviewedAt`/`completedAt`. `reviewedAt` se nastaví napoprvé, kdy task
opustí `open` (i `dismissed` počítá jako "člověk se na to podíval");
`completedAt` jen při `completed`. Žádné pole se nepřepisuje podruhé.

### Endpoints

```bash
# spustit business agenta — input se (stejně jako u wave 1) auto-sesbírá,
# pokud ho nezadáte ručně
curl -X POST http://localhost:3001/admin/agents/run-business-agent \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"agentName":"crm_follow_up","entityType":"lead","entityId":"lead_xxx"}'

# seznam (filtry: agentName/status/entityType/taskType/search/limit/offset)
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/agent-tasks?status=open"

# detail
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/agent-tasks/<ID>

# změna stavu
curl -X PATCH http://localhost:3001/admin/agent-tasks/<ID>/status \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"status":"reviewed"}'

# export CSV
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/agent-tasks/export.csv -o agent-tasks.csv
```

### admin-agent-tasks.html

Seznam s filtry, panel pro ruční spuštění libovolného z 9 business
agentů (agent/typ entity/ID), detail s tlačítkem „Copy suggested
message" (kopíruje draft do schránky — odeslání zůstává na adminovi) a
Mark reviewed/completed/Dismiss.

### Katalog agentů + AI health (admin-ai-runs.html)

`admin-ai-runs.html` má navíc dva panely nahoře:

- **AI health** (`GET /admin/ai/health`) — `aiEnabled`/`provider`/
  `configured`/`model`/`openai.keyPresent`/`openai.budgetConfigured`/
  `vin.vincarioEnabled`/`vin.vincarioKeyPresent`/`vin.vincarioSecretPresent`.
  Nikdy žádná hodnota klíče, jen `true`/`false`.
- **Katalog agentů** (`GET /admin/ai/agents`) — všech 14 registrovaných
  agentů (5 report + 9 business) s `role`/`kind`/`entityTypes`/
  `riskLevel`/`status`, a v detailu i `allowedActions`/`forbiddenActions`/
  `systemPrompt` (shrnutí)/`inputTypes`/`outputFormat`. Tlačítko „Run
  test" v detailu spustí agenta na zadané `entityId` — report-kind přes
  `POST /admin/ai/run` (výsledek v tabulce AI runs na téže stránce),
  business-kind přes `POST /admin/agents/run-business-agent` (výsledek
  na `admin-agent-tasks.html`). API klíč se v tomhle panelu nikdy
  nezobrazuje.

### Integrace do existujících admin stránek

Tři tlačítka, každé volá `POST /admin/agents/run-business-agent` a pak
odkazuje na `admin-agent-tasks.html` přefiltrováno na výsledek:

- `admin-leads.html` → „Generate follow-up" → `crm_follow_up`
- `admin-bookings.html` → „Suggest next step" → `crm_follow_up`
- `admin-payments.html` → „Analyze payment issue" → `operations_payment`

`b2b_sales` a `support` nemají vlastní tlačítko nikde jinde — spouští se
přes obecný panel na `admin-agent-tasks.html`, který pokrývá všechny 4
agenty rovnocenně.

## Real VIN provider adapter

Architektura, díky které jde jednou vyměnit demo VIN výsledek za skutečný
provider, **aniž by se přepisoval zbytek produktu** — veřejný formulář,
platby, reporty, AI agenti nic z tohohle kroku nevidí a nemění se pro ně
nic.

### Honest status

**Vincario (api.vincario.com) je teď skutečně zapojený** —
`backend/vin/vincarioProvider.js` implementuje jejich control-sum
autentizaci a volá `decode/info` (primárně) s fallbackem na `decode`.
Otestováno v tomhle kroku proti skutečnému `api.vincario.com` (ne jen
teoreticky) — třemi různými VINy, viz níže. Dvě věci, které z toho
plynou:

1. **Vincario `decode`/`decode/info` vrací jen technické specifikace**
   (výrobce/model/rok/motor/karoserie/…), **ne historii nehod/najeto km/
   majitele** — to je u Vincario samostatný, placený VHR produkt, který
   tenhle adaptér nevolá. `history`/`accidents`/`owners`/`score` proto
   v normalizovaném výsledku zůstávají prázdné/`null`, nikdy vymyšlené.
2. **Klíče v ukázkovém `.env.txt`, se kterými se tohle testovalo
   (`0e84bc0986a5`/`7f2d5614db`), Vincario odmítl s `Invalid Control
   sum`** — na třech různých reálných VINech konzistentně stejná chyba,
   což ukazuje na neplatný/neaktivní pár klíč+secret (vypadají jako
   ukázkové hodnoty z dokumentace Vincario, ne jako reálný placený
   účet), ne na chybu v tomhle kódu. Backend to zpracoval přesně jak má:
   nespadl, ukázal jasnou chybu adminovi, nikdy nevypsal klíč/secret/
   control sum/plnou URL. S vlastním reálným klíčem z Vincario dashboardu
   stačí je vyměnit v `.env` — nic dalšího se měnit nemusí.

Starší, obecný `real` režim (`backend/vin/realVinProviderAdapter.js`,
Bearer token) zůstává beze změny jako fallback pro jiného providera —
pro něj platí, že **žádný konkrétní jiný VIN/vehicle-history provider
není vybraný ani zapojený**, psaný podle obecného vzoru, ne podle
konkrétní schémy. Než se TENHLE (obecný, ne-Vincario) použije s
reálnými penězi:

1. **Vyberte konkrétního poskytovatele** s jasnými ToS, které dovolují
   tenhle use-case (komerční VIN/vehicle-history lookup, zobrazení
   zákazníkovi). Nescrapujte weby bez výslovného svolení — to je mimo
   scope a mimo zákon v řadě jurisdikcí.
2. **Přečtěte si jejich ToS ohledně cachování/ukládání/redistribuce**
   výsledků — `vin_provider_runs` ukládá `responseJson` (raw odpověď)
   natrvalo; pokud to ToS providera zakazuje, tenhle krok potřebuje
   upravit (např. neukládat raw odpověď natrvalo, nebo nastavit retenci).
3. **Upravte `parseProviderResponse()` v `realVinProviderAdapter.js`**
   podle skutečné, zdokumentované schémy odpovědi vybraného providera —
   současná verze zkouší několik běžných konvencí názvů polí
   (`year`/`vehicle_year`, `mileage`/`odometer`, ...), což je hádání, ne
   záruka.
4. **Otestujte proti jejich sandboxu**, pokud ho nabízí, než pustíte
   ostrý klíč.

### Provider architektura (`backend/vin/`)

| Soubor | Co dělá |
|---|---|
| `vinProvider.js` | Factory — `getVinProvider()` vrátí `demo`/`real` (Vincario, nebo fallback na obecný adapter)/`mock_real` podle `VIN_PROVIDER` |
| `demoVinProvider.js` | **Beze změny** přenesená stará demo logika (`hashVin`/`generateVinResult`) — `POST /vin/check` ji používá napřímo, bez ohledu na `VIN_PROVIDER` |
| `realVinProviderAdapter.js` | Obecný `real` (Bearer token, `VIN_API_BASE_URL`/`VIN_API_KEY`) + `mock_real` (simulace stejné parse pipeline, bez sítě) — fallback, když Vincario není nakonfigurovaný |
| `vincarioProvider.js` | **Skutečný Vincario adaptér** — control-sum auth, `decode/info` + `decode` fallback, viz „Vincario adapter" níže |
| `vinConfig.js` | Env flagy na jednom místě (obojí — obecný adapter i Vincario) |
| `vinNormalizer.js` | Coerce libovolného providerova výstupu do jednotné kanonické schémy |
| `vinCostLogger.js` | Spustí providera + zaloguje celý lifecycle do `vin_provider_runs` |

### Env

```bash
VIN_PROVIDER=demo    # demo (default) | real | mock_real
VIN_API_BASE_URL=    # jen pro VIN_PROVIDER=real, obecný adapter (ne Vincario)
VIN_API_KEY=          # jen pro VIN_PROVIDER=real, obecný adapter — nikdy necommitovat
VIN_PROVIDER_TIMEOUT_MS=10000
VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK=true   # money-safety default, viz níže

# Vincario adaptér — samostatný, nezávislý blok (viz „Vincario adapter" níže)
VIN_PROVIDER_ENABLED=false
VIN_PROVIDER_NAME=vincario
VIN_PROVIDER_BASE_URL=https://api.vincario.com/3.2
VIN_PROVIDER_API_KEY=       # z Vincario dashboardu — nikdy necommitovat
VIN_PROVIDER_SECRET_KEY=    # z Vincario dashboardu — nikdy necommitovat
VIN_PROVIDER_FORMAT=json
```

### Vincario adapter (`backend/vin/vincarioProvider.js`)

Zvolí se automaticky místo obecného `real` adaptéru, když `VIN_PROVIDER=real`
**a** `VIN_PROVIDER_ENABLED=true` **a** oba klíče (`VIN_PROVIDER_API_KEY`,
`VIN_PROVIDER_SECRET_KEY`) jsou nastavené — jinak se nic nemění a `real`
dál znamená obecný Bearer-token adaptér jako předtím.

**Autentizace:** `CONTROL_SUM` = prvních 10 hex znaků
`sha1(VIN + ID + API_KEY + SECRET_KEY)`, kde `ID` je `"info"` pro
`decode/info`, `"decode"` pro `decode`. VIN se vždy převede na
UPPERCASE před výpočtem i před voláním.

```
GET /3.2/{API_KEY}/{CONTROL_SUM}/decode/info/{VIN}.json   ← primárně
GET /3.2/{API_KEY}/{CONTROL_SUM}/decode/{VIN}.json        ← fallback, pokud decode/info selže
```

Vincario vrací `{"decode": [{"label": "...", "value": "..."}, ...]}` —
pole label/value dvojic (make/model/model year/body/fuel type/engine/
plant country/…), NE pevná jména polí. `parseVincarioResponse()` si z
nich postaví lookup a naplní `vehicle.{make,model,year,bodyType,
fuelType,engineDisplacementCcm,enginePowerHp,driveType,plantCountry}` —
`history`/`accidents`/`owners`/`score` zůstávají prázdné (viz „Honest
status" výše, proč).

**Chyby nikdy neobsahují klíč/secret/control sum/plnou URL** —
`safeProviderError()` vrací jen HTTP status + Vincario's vlastní
`message` pole (např. `"Invalid Control sum"`, `"Invalid VIN"` apod.),
nic víc. Timeout přes `VIN_PROVIDER_TIMEOUT_MS` (default 10s), bez
retry.

```bash
# ověří, že admin je přihlášen a VIN check zaplacený, pak zavolá Vincario
curl -X POST http://localhost:3001/admin/vin-checks/<ID>/run-provider \
  -H "x-admin-password: VASE_HESLO"
```

### Diagnostika trial/plánu — `GET /admin/vin/provider-health`

**Než koupíte placený tarif u Vincario, nejdřív ověřte provider-health,
balance a jeden decode požadavek** přes tenhle endpoint — zjistí, jestli
je problém ve špatných klíčích, v trial/plan omezení, v prázdném
balance, nebo v síti, aniž byste museli platit za vyšší tarif napřed.

Bezpečný diagnostický řetězec (nikdy nespadne, nikdy nevrátí klíč/
secret/control sum/plnou URL — i Vincario's vlastní chybové hlášky, které
tyhle hodnoty občas echo-nou zpátky v textu, se před uložením/vrácením
vždy nahradí `[REDACTED-A]`/`[REDACTED-B]` placeholdery, viz
`sanitizeProviderMessage()`):

1. **`urlConsistencyCheck`** — čistě lokální kontrola (žádné síťové
   volání): dokazuje, že normalizovaná base URL (`deriveBases()`) nikdy
   neobsahuje `/3.2` dvakrát ani žádnou, bez ohledu na to, jestli
   `VIN_PROVIDER_BASE_URL` v `.env` `/3.2` má nebo ne.
2. **`balance`** — account-level endpoint BEZ VIN, **jen informativní**
   (viz níže, proč se nikdy nepoužívá k závěru o credentials).
3. **`decodeInfo`** — primární, dokumentovaný endpoint na jednom
   testovacím VIN (default `WVWZZZ1JZXW000010`, nebo `?vin=...`).
4. **`decodeInfoNoVersion`** — pokud (3) selže: stejný request, ale BEZ
   `/3.2` v URL vůbec (test hypotézy, že verze nemusí být literální
   path segment).
5. **`decodeFallback`** — pokud (3) i (4) selžou: `decode` bez `/info`.

Každý krok je nezávisle try/catch — selhání jednoho nezastaví další.
**`balance` se nikdy nepoužívá k diagnóze** — jen `decodeInfo`/
`decodeInfoNoVersion`/`decodeFallback` jsou autoritativní (viz explicitní
požadavek: 404 na balance sám o sobě nikdy neznamená "invalid
credentials" — Vincario nemusí `balance` na daném plánu vůbec nabízet).

```bash
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/vin/provider-health
# s vlastním testovacím VINem:
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/vin/provider-health?vin=1C4RJFCM0EC285181"
# + bezpečný debug trace (attemptedVariantName/method/maskedRoute/status/providerErrorMessage, bez secrets):
curl -H "x-admin-password: VASE_HESLO" "http://localhost:3001/admin/vin/provider-health?debug=1"
```

Odpověď obsahuje `vinProviderEnabled`/`vinProviderMode`/`vinProviderName`/
`vinProviderBaseUrl` (nic z toho není secret), `apiKeyPresent`/
`apiKeyLength`/`secretKeyPresent`/`secretKeyLength` (délka, nikdy
hodnota), `urlConsistencyCheck`, výsledek každého kroku
(`{ok, code, message}` nebo `{ok:true}`), a hlavně `diagnosis` +
`diagnosisMessage` — plain-language shrnutí, co přesně brání reálnému
decode:

| `diagnosis` | Co to znamená |
|---|---|
| `working` | Reálný decode prošel — klíč/secret/plán fungují právě teď. |
| `checksum_invalid` | Decode/decode-info route se našla, ale control sum neprošel (`providerChecksumInvalid`) — problém v páru klíč+secret, ne v endpointu/plánu. |
| `route_not_found` | 404 "route could not be found" na decode/decode-info (`providerEndpointUnavailable`) — request se vůbec nedostal k ověření checksum; **není to nutně credentials problém**, spíš špatná cesta nebo route na daném trial účtu neexistuje. |
| `product_not_enabled` | Vincario požadavek rozpoznal, ale produkt/service není na tomhle plánu povolený (`providerProductNotEnabled`). |
| `trial_plan_restricted` | Credentials OK, ale endpoint zamítnut jako mimo plán/trial (`providerPlanLimited`). |
| `invalid_credentials` | Obecné unauthorized na decode route (`providerUnauthorized`, bez specifické checksum/plan zmínky). |
| `quota_or_balance_empty` | Nedostatek kreditů/balance (`providerQuotaEmpty`). |
| `network_error` | Nedostupné `api.vincario.com` vůbec (`providerNetworkError`). |
| `not_configured` | `VIN_PROVIDER_ENABLED`/klíč/secret chybí. |

Klasifikace chyb (`classifyVincarioError()` v `vincarioProvider.js`) —
sdílená mezi tímhle diagnostickým endpointem i běžným
`run-provider`/`POST /vin/check` tokem, vždy na RAW textu **před**
redakcí (viz `sanitizeProviderMessage()`'s komentář — dřívější verze
měla bug, kdy placeholder text sám obsahoval slovo „checksum" a falešně
spouštěl klasifikátor na vlastní redakci; teď se klasifikuje první, pak
teprve redaguje):

| HTTP/text od Vincario | `error`/`code` |
|---|---|
| text o "invalid control sum"/"checksum" | `providerChecksumInvalid` |
| text o "not enabled"/"access denied to this product/service" | `providerProductNotEnabled` |
| 404, nebo text "route ... could not be found" | `providerEndpointUnavailable` |
| 402/429, nebo text o "quota"/"balance"/"credit"/"insufficient" | `providerQuotaEmpty` |
| 401/403 + "plan"/"upgrade"/"trial"/"not allowed" v textu | `providerPlanLimited` |
| 401/403 (bez zmínky o plánu) | `providerUnauthorized` |
| "Invalid VIN" v textu | `invalidVin` |
| timeout/network chyba | `providerNetworkError` |

### Demo vs real vs mock_real

- **`demo`** (default) — jediný režim, který **veřejný** `POST /vin/check`
  kdy použije, bez ohledu na `VIN_PROVIDER`. Deterministické, zdarma,
  offline. Beze změny chování — ověřeno bajt-po-bajtu proti hodnotám
  před touhle refaktorizací pro stejný VIN.
- **`real`** — skutečné HTTP volání na `VIN_API_BASE_URL`. Volá se
  **jen** z admin endpointu (`POST /admin/vin-checks/:id/run-provider`),
  nikdy z veřejného formuláře. Bez `VIN_API_BASE_URL`/`VIN_API_KEY`
  vrátí `503 PROVIDER_NOT_CONFIGURED`, backend nespadne.
- **`mock_real`** — běží přes **stejnou** `parseProviderResponse()`
  logiku jako `real`, ale se simulovanou odpovědí — žádná síť, žádné
  API klíče, žádné náklady. Výsledek je **vždy** `isDemoResult: true`,
  `provider: "mock_real"` — nikdy se netváří jako reálná data. Slouží k
  ověření, že normalizační pipeline funguje, než se vůbec sáhne po
  reálném klíči.

### Jak se předchází placeným voláním bez platby

`VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK=true` (default) — `POST
/admin/vin-checks/:id/run-provider` kontroluje `vinCheck.paymentStatus
=== 'paid'` **před** jakýmkoliv voláním providera, `real` i `mock_real`
stejně (ověřeno testem — gate blokuje i bezplatný `mock_real`, není to
tedy "přeskoč kontrolu když to nic nestojí", je to skutečný princip).
Nezaplacený VIN check dostane `400 PAYMENT_REQUIRED` s jasnou zprávou,
žádné volání se neuskuteční. Jediný způsob, jak tohle obejít, je admin
vědomě nastavující `VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK=false`.

### Normalizovaná schéma (`vinNormalizer.js`)

```json
{
  "provider": "demo|real|mock_real",
  "isDemoResult": true,
  "vehicle": {},
  "history": {},
  "risks": [],
  "score": 0,
  "riskLevel": "low|medium|high",
  "rawAvailable": true,
  "disclaimer": "..."
}
```

Nikdy nevrací `undefined`/nevalidní hodnoty — `vinNormalizer.js` každé
pole zkontroluje/defaultuje, takže i neočekávaná odpověď reálného
providera nikdy neprojde jako rozbitá data dál do produktu.

### `vin_provider_runs` — plný audit trail

`id`/`vinCheckId`/`provider`/`status` (`running`→`completed`/`failed`)/
`requestJson`/`responseJson`/`normalizedJson`/`costEstimate`/
`errorMessage`/`createdAt`/`updatedAt`. Řádek se vytvoří **před**
voláním providera (přežije i pád uprostřed volání), stejný vzor jako
`ai_agent_runs`.

### Admin endpoints

```bash
# spustit real/mock_real provider pro zaplacený VIN check
curl -X POST http://localhost:3001/admin/vin-checks/<ID>/run-provider \
  -H "x-admin-password: VASE_HESLO"

# historie provider runs pro tenhle VIN check
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/vin-checks/<ID>/provider-runs
```

### admin-vin-checks.html

Tlačítko „Run real VIN provider" se **schová úplně**, pokud je
`VIN_PROVIDER=demo` (nic by nebylo co spustit) — viditelnost řídí
`vinProviderMode` v odpovědi `GET /admin/vin-checks/:id`. Panel ukazuje
normalizovaná data (score/risk/risks/disclaimer/isDemoResult), stav a
chybu — **raw request/response JSON se v panelu záměrně nevykresluje**,
zůstává dostupný jen přes API/DB pro debugging, ne jako výchozí
zobrazení.

### Cost risks

Skutečný náklad na `real` volání (Vincario i obecný adaptér) závisí
čistě na tom, jaký kredit/kontrakt admin má u zvoleného providera —
tenhle kód to nemůže vědět, takže `costEstimate` u `real` runů upřímně
říká "(unknown)", ne vymyšlené číslo. `VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK`
je hlavní automatická
ochrana proti utrácení bez příjmu — žádný budgetový strop pořád není,
ale `POST /admin/vin-checks/:id/run-provider` má od launch-prep
etapy vlastní rate limit (stejné okno jako ostatní write-endpointy) —
najito při finálním auditu jako jediný cost-relevantní endpoint bez
téhle ochrany, opraveno hned na místě.

## Inspector workflow

Základní **admin-managed** workflow pro fyzickou prohlídku vozidla — bez
marketplace, bez automatických výplat, bez veřejného přihlášení technika.

### Co to je a co (zatím) není

- **Je to admin-managed workflow.** Technik nemá žádný účet, žádné
  přihlášení, žádnou vlastní obrazovku. Vše — přiřazení, termín, stav,
  checklist — nastavuje admin na `admin-inspection-jobs.html`. Technik
  dostane informace jinou cestou (telefon, email mimo systém) — to
  tenhle krok neřeší.
- **Výplaty jsou manuální.** `inspectors`/`inspection_jobs` nemají
  žádné finanční pole (žádná sazba, žádná částka k výplatě, žádný
  payout status). Kolik a jak se technikovi zaplatí je čistě mimo tenhle
  systém.
- **Není to marketplace.** Technici se nepřihlašují sami, nenabízí své
  služby, nevidí žádné objednávky — jsou to jen záznamy (jméno, kontakt,
  kvalifikace), které admin ručně přiřazuje k jobům.
- **Checklist je čistě textový.** Žádné nahrávání fotek, žádná AI
  analýza obrázků — hodnota položky je `ok`/`issue`/`not_checked` +
  volný komentář.

### Tabulky

`inspectors` — id/name/email/phone/city/qualification/active/
internalNote/createdAt/updatedAt. Žádné DELETE — `active: false`
deaktivuje bez ztráty historie (stejný vzor jako `agents`).

`inspection_jobs` — id/bookingId/inspectorId/status/scheduledAt/
location/customerContact/internalNote/createdAt/updatedAt/completedAt.
Přesně jeden job na booking (vynucováno idempotentní kontrolou při
vytváření — druhý pokus vrátí `400 ALREADY_EXISTS` s id existujícího
jobu, nikdy duplicitu).

`inspection_checklist_items` — id/jobId/category/label/value/comment/
sortOrder/createdAt/updatedAt. Výchozí sada (12 položek, 5 kategorií:
exterior/interior/mechanical/documents/test_drive) se vytvoří jedním
voláním a je idempotentní — druhé volání na job, který už položky má,
nic nezduplikuje, jen vrátí stávající.

### Stavy `inspection_jobs`

`created → assigned → scheduled → in_progress → checklist_done →
admin_review → completed` (+ `cancelled` kdykoliv). Každý přechod
nastavuje výhradně admin přes `PATCH /admin/inspection-jobs/:id` —
nic se neposouvá samo.

### Propojení se statusem objednávky

`ADMIN_BOOKING_STATUSES` už před tímhle krokem obsahovalo
`inspector_needed`/`inspector_assigned`/`inspection_scheduled` (a
`admin-bookings.html`'s vlastní status-dropdowny je už zobrazovaly) —
tenhle krok je poprvé skutečně používá. Booking status **postupuje jen
dopředu** v pevné sekvenci `paid → inspector_needed →
inspector_assigned → inspection_scheduled → completed`:

- vytvoření jobu: `paid` → `inspector_needed`
- přiřazení technika (poprvé): → `inspector_assigned`
- job status → `scheduled`: → `inspection_scheduled`
- job status → `completed`: → `completed`

Nikdy nejde zpátky, a nikdy se nedotkne bookingu, jehož status je mimo
tuhle sekvenci (`cancelled`/`spam`/`archived` zůstávají, jak jsou).

### Endpoints

```bash
# technici — CRUD
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/inspectors
curl -X POST http://localhost:3001/admin/inspectors -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"name":"Jan Novák","city":"Praha"}'
curl -X PATCH http://localhost:3001/admin/inspectors/<ID> -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"active":false}'

# vytvořit job ze zaplacené objednávky (jediný způsob, jak job vznikne)
curl -X POST http://localhost:3001/admin/bookings/<BOOKING_ID>/inspection-job -H "x-admin-password: VASE_HESLO"

# spravovat job
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/inspection-jobs
curl -X PATCH http://localhost:3001/admin/inspection-jobs/<ID> -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"status":"assigned","inspectorId":"inspector_xxx"}'

# checklist
curl -X POST http://localhost:3001/admin/inspection-jobs/<ID>/checklist/defaults -H "x-admin-password: VASE_HESLO"
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/inspection-jobs/<ID>/checklist
curl -X PATCH http://localhost:3001/admin/inspection-checklist-items/<ITEM_ID> -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"value":"issue","comment":"Rez na blatníku"}'
```

### admin-inspectors.html / admin-inspection-jobs.html

Desátá a jedenáctá admin stránka. `admin-inspectors.html` — jednoduchý
CRUD (create/edit v jednom modalu, aktivní/neaktivní, CSV). 
`admin-inspection-jobs.html` — detail se dvěma záložkami: Summary
(stav/technik/termín/lokace/kontakt/poznámka) a Checklist (položky
seskupené podle kategorie, inline select + komentář, uloží se ihned po
změně).

### Integrace s objednávkami

`admin-bookings.html` → detail → panel „Fyzická prohlídka": tlačítko
„Create inspection job" je aktivní jen pro `status="paid"` (i backend to
vynucuje nezávisle — tlačítko není jediná ochrana). Po vytvoření se
panel automaticky přepne na zobrazení odkazu na existující job — druhé
kliknutí na tutéž objednávku už žádné tlačítko nenabízí.

## Dealer workflow

Základní **admin-managed** workflow pro autosalony: profil dealera,
jejich vozidla, a „verified" badge — bez dealer loginu, bez veřejného
marketplace, bez subscription/recurring plateb (nejsou v tomhle
projektu implementované), a badge nikdy nevzniká automaticky.

### Co to je a co (zatím) není

- **Žádný dealer login.** Dealer nemá účet, heslo, ani žádnou vlastní
  obrazovku — všechno (profil, vozidla, badge žádosti) spravuje admin
  na `admin-dealers.html`/`admin-badges.html`.
- **Žádný veřejný marketplace.** Dealeři a jejich vozidla se nikde
  veřejně nevypisují ani nevyhledávají — jediná veřejná věc je
  `badge.html?code=...`, a to jen pro konkrétní badge kód, který někdo
  už má (typicky vložený na dealerův vlastní inzerát).
- **Badge nikdy nevzniká automaticky.** Dvojitá pojistka, obě
  vynucované na backendu (ne jen v UI): (1) žádost o badge jde vytvořit
  jen pro vozidlo dealera se stavem `verified` — a dealera na
  `verified` posouvá výhradně admin; (2) žádost samotná začíná na
  stavu `requested` a na `approved` ji posouvá výhradně admin přes
  `PATCH /admin/badges/:id/status` — nikdy nic jiného.
- **Bez subscription/recurring plateb.** `expiresAt` je jednorázové
  datum (default 365 dní od schválení), ne opakovaná platba — po
  vypršení badge automaticky (lazy, při dalším čtení) přejde na
  `expired`, žádné prodloužení samo od sebe neproběhne.

### Tabulky

`dealers` — id/companyName/contactName/email/phone/city/website/status/
internalNote/createdAt/updatedAt. Nová firma vždy začíná na
`pending` bez ohledu na to, co pošle caller (viz `insertDealer()`) —
jediná cesta na `verified` je explicitní admin PATCH.

`dealer_vehicles` — id/dealerId/vin/make/model/year/listingUrl/status/
createdAt/updatedAt. `status` (`active`/`sold`/`archived`) není v
zadání tohoto kroku explicitně — vlastní rozumné doplnění pro
životní cyklus vozidla, nezávislé na stavu jeho badge (viz níže).

`verified_badges` — id/dealerId/vehicleId/status/badgeCode/issuedAt/
expiresAt/revokedAt/internalNote/createdAt/updatedAt. `badgeCode` je
10znakový, sdílitelný (ne tajný jako report token) kód generovaný z
bezpečné abecedy bez vizuálně matoucích znaků (0/O, 1/I/L) — myšlený k
vložení na dealerův inzerát, ne k utajení.

### Stav dealera vs. stav badge — dvě různé věci

Stav dealera (`pending`/`verified`/`rejected`/`suspended`) říká, jestli
NEXIUM důvěřuje dealerovi jako firmě. Stav badge
(`requested`/`approved`/`rejected`/`revoked`/`expired`) říká, jestli
je KONKRÉTNÍ vozidlo ověřené. Vozidlo `verified` dealera může mít
badge `revoked` (něco se změnilo) a naopak dřívější badge zůstává
historicky viditelný i po suspendaci dealera — jedno nepřepisuje
druhé.

### `expired` — nikdy ruční akce

`PATCH /admin/badges/:id/status` **odmítne** `status: "expired"` —
vrátí `400` s jasnou zprávou. Expirace je čistě automatická: kdykoliv
se badge čte (admin list/detail, nebo veřejná stránka) a
`status === "approved"` s `expiresAt` v minulosti, backend ho rovnou
při tom čtení přepne na `expired` (viz `withLazyExpiry()` v
`verifiedBadgesRepository.js`) — nemá to žádný cron/background job,
ale zpoždění je nanejvýš do dalšího čtení.

### Endpoints

```bash
# dealer z existujícího dealer_request leadu (lead se nijak nemění)
curl -X POST http://localhost:3001/admin/dealers/from-lead/<LEAD_ID> -H "x-admin-password: VASE_HESLO"

# dealer — CRUD
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/dealers
curl -X PATCH http://localhost:3001/admin/dealers/<ID> -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"status":"verified"}'

# vozidlo dealera
curl -X POST http://localhost:3001/admin/dealer-vehicles -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"dealerId":"dealer_xxx","vin":"...","make":"Škoda","model":"Octavia","year":2019}'

# žádost o badge (jen pro verified dealera)
curl -X POST http://localhost:3001/admin/dealer-vehicles/<VEHICLE_ID>/badge -H "x-admin-password: VASE_HESLO"

# schválit/zamítnout/zrušit
curl -X PATCH http://localhost:3001/admin/badges/<ID>/status -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"status":"approved"}'

# veřejné — bez hesla
curl http://localhost:3001/badges/public/<BADGE_CODE>
```

### Co je public/safe na `GET /badges/public/:badgeCode`

Vrací **výhradně**: badge status/kód/issuedAt/expiresAt, dealerovo
`companyName` (nikdy contactName/email/phone/internalNote), vozidlovo
vin/make/model/year/listingUrl, a statický disclaimer. 404 pro
neexistující kód používá stejnou obecnou zprávu jako pro cokoliv
jiného neplatného — nejde tak enumerací zjistit, které kódy existují.
Stránka vždy zobrazuje **skutečný** stav — `requested`/`rejected`/
`revoked`/`expired` se nikdy netváří jako `approved` (ověřeno explicit
testem — viz níže).

### `badge.html?code=...`

Veřejná stránka, žádné heslo, žádná session, mluví jen s tímhle jedním
public endpointem (stejný vzor jako `report.html`/`report-public.js` —
sdílí i `report.css`). Pět stavů má vlastní honest formulaci — např.
`requested` výslovně říká „zatím nebyl adminem NEXIUM schválen", ne
nic, co by vypadalo jako potvrzení.

### admin-dealers.html / admin-badges.html

Dvanáctá a třináctá admin stránka. `admin-dealers.html` — seznam,
tlačítko „+ Z dealer_request leadu" (picker z otevřených leadů),
detail se záložkami Summary/Vozidla (přidání vozidla inline).
`admin-badges.html` — seznam, detail s Approve/Reject/Revoke, Copy
code/Copy public link, CSV.

## Revenue-share 20%

Prozatím čistě **účetní/evidenční systém** — nikdy sám o sobě nepřevádí
peníze. Založeno na obchodní domluvě mezi majitelem projektu a
partnerem/tvůrcem systému (20 % z eligible měsíční výnosu).

**Poctivá poznámka k tomuhle bodu:** tenhle kód nemůže sám ověřit, že
majitel webu s touhle dohodou skutečně souhlasil — má k dispozici jen
zadání úkolu. Silně doporučujeme, aby tahle dohoda byla **navíc**
zachycená v samostatné písemné smlouvě mezi stranami, ne jen jako
konfigurace v kódu — chrání to obě strany a config/kód sám o sobě
nikdy nemá sloužit jako jediný doklad souhlasu.

### Proč to není skrytá transakce

- Výchozí stav je **`enabled: false`** — dokud to admin sám nezapne,
  nic se neeviduje vůbec.
- Žádný automatický převod peněz kamkoliv — `markPayoutPaid()` jen
  zaznamenává, že **člověk sám** už peníze poslal mimo tenhle systém.
  V celém kódu neexistuje jediné volání na Wise API ani žádný jiný
  platební/transferový endpoint.
- Každá eligible placená platba se objeví v ledgeru — nic se neschovává,
  nic se nefiltruje ven z pohledu adminu.
- Plný CSV export ledgeru i payoutů, kdykoliv.
- Startup log backendu vždy hlásí aktuální stav (`Revenue-share:
  ENABLED (X%, ...)` nebo `disabled`) — nejde si toho nevšimnout.
- `payoutRecipientMasked` backend explicitně odmítne, pokud vypadá jako
  celé číslo karty/účtu (12+ číslic za sebou) — do systému se úmyslně
  nedá uložit nic použitelného k reálnému převodu.

### Jak funguje výpočet

`eligible monthly revenue` = součet `paymentAmount` všech **paid**
plateb za kalendářní měsíc s productCode v `vin_basic_report`/
`inspection_booking_deposit`/`manual_car_review`, které nejsou
refunded/cancelled/failed.

```
shareAmount (za platbu) = round(payment.amount × sharePercent / 100)
```

Při každé skutečně nové `paid` platbě (ne při opakovaném webhooku —
idempotence řešena na dvou úrovních, viz níž) vznikne přesně jeden
řádek v `revenue_share_ledger`:
- `status: "accrued"` — eligible productCode, počítá se do výnosu;
- `status: "excluded"` — placená platba, ale neeligible productCode;
  `shareAmount: 0`. Drží se kvůli **úplnému** auditnímu záznamu — admin
  vidí úplně každou placenou platbu a proč se počítala/nepočítala, ne
  jen ty, co se počítaly.

`monthKey` (`YYYY-MM`) se počítá **v timezone z nastavení**
(`Intl.DateTimeFormat`), ne v UTC — platba těsně před půlnocí na konci
měsíce může spadnout do jiného měsíce podle toho, jaká timezone je
nastavená. Ověřeno testem přesně na tomhle hraničním případu.

### Měsíční payout

`POST /admin/revenue-share/payouts/calculate` s `{"monthKey":"2026-09"}`:
1. Sečte všechny `accrued` ledger řádky pro daný měsíc (po měnách
   zvlášť, kdyby jich bylo víc).
2. Vytvoří `monthly_payouts` řádek, `status: "pending_manual_transfer"`
   **hned** (bez mezikroku) — jediné, co v tomhle kroku vzniká.
3. Přesune odpovídající ledger řádky na `included_in_payout`.

`payoutDueAt` = 1. den **následujícího** měsíce (nebo jiný `payoutDay`
z nastavení) v `payoutTime` v nastavené timezone — počítáno
timezone-aware (funguje správně i přes DST přechody, ověřeno testem).

Druhý pokus o výpočet stejného měsíce → `400 ALREADY_EXISTS` s id
existujícího payoutu, nikdy duplicita (ověřeno explicitně — druhý
pokus **musí** hlásit specificky "už existuje", ne obecné "není co
počítat", což byla chyba nalezená a opravená během testování tohohle
kroku).

### Jak bezpečně provést Wise payout

**Reálný převod v tomhle kroku není implementovaný záměrně** — jde o
samostatný krok až po legal/payment review, který zadání explicitně
odděluje:

1. Admin otevře `admin-revenue-share.html` → záložka Payouts, najde
   payout se stavem `pending_manual_transfer`.
2. Admin **ručně** provede převod přes Wise (web/app), mimo tenhle
   systém.
3. Admin klikne „Mark as paid" — zaznamená se `markedPaidAt`, stav
   `paid`. Tohle je čistě evidence, ne akce, která cokoliv posílá.

Žádné Wise API klíče/credentials se nikde v kódu ani `.env.example`
neobjevují — `payoutMethod`/`payoutRecipientLabel`/
`payoutRecipientMasked` jsou jen popisné pole v admin UI, nikdy funkční
přístupové údaje.

### Scheduling — zatím ručně

`POST /admin/revenue-share/payouts/calculate` se spouští ručně (admin
UI tlačítko, nebo curl). Automatický cron 1. dne v 10:00 je
zdokumentovaný jako **další krok**, ne implementovaný teď — přidání by
znamenalo jen zavolat stejnou `createMonthlyPayout()` funkci z
node-cron joba, řízeného `REVENUE_SHARE_CRON_ENABLED=false` (výchozí
vypnuto), ale tenhle krok to úmyslně nedělá, aby nezavedl riziko
špatně načasovaného/duplicitního běhu bez lidské kontroly.

### Refunds — zatím neřešeno

Pokud platba dostane refund **po** tom, co už byla zahrnuta do
`accrued`/`included_in_payout` ledger řádku, tenhle krok **nemá**
mechanismus na automatické stažení podílu zpět — `status: "reversed"`
existuje jako připravený stav v enumu, ale nic ho zatím nenastavuje.
Admin musí řešit ručně (úprava přes přímý přístup k DB, nebo počkat na
samostatný refund-handling krok). Zaznamenáno jako známé omezení, ne
tiše ignorováno.

### Endpoints

```bash
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/revenue-share/settings
curl -X PATCH http://localhost:3001/admin/revenue-share/settings -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"enabled":true,"sharePercent":20}'
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/revenue-share/ledger
curl -X POST http://localhost:3001/admin/revenue-share/payouts/calculate -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" -d '{"monthKey":"2026-09"}'
curl -X PATCH http://localhost:3001/admin/revenue-share/payouts/<ID>/mark-paid -H "x-admin-password: VASE_HESLO"
```

### admin-revenue-share.html

Čtrnáctá admin stránka. Tři záložky: Settings, Ledger, Payouts. Vždy
zobrazuje: **„Revenue-share is transparent and visible to admin. No
automatic hidden transfers are performed."**

## Forecast / business scenario planning

**Toto je hypotetický kalkulátor, ne slib ani záruka příjmu.** Ceny
(minor units, CZK): VIN Basic Report 99–199 Kč, Manual Car Review
199–590 Kč, Inspection Booking Deposit 499–2 490 Kč — reálně
nakonfigurováno v `backend/payments/products.js` na spodní hranici
těchto rozsahů.

| Scénář | Prodejů/měsíc | Ø cena | Gross revenue | 20 % share | Zbývá (80 %) |
|---|---|---|---|---|---|
| Opatrný | 20–50 | ~200 Kč | 4 000–10 000 Kč | 800–2 000 Kč | 3 200–8 000 Kč |
| Základní | 50–150 | ~250 Kč | 12 500–37 500 Kč | 2 500–7 500 Kč | 10 000–30 000 Kč |
| Silný | 150–300+ | ~300 Kč | 45 000–90 000+ Kč | 9 000–18 000+ Kč | 36 000–72 000+ Kč |

Provozní náklady (SMTP, hosting, případně reálný VIN-provider/GPT
náklady) **nejsou v téhle tabulce odečtené** — nejsou v tomhle kroku
známé jako konkrétní čísla. Tohle je scenario planning k orientaci, ne
finanční prognóza — žádné číslo tady není garantovaný příjem.

## GPT API readiness (real OpenAI provider — implemented)

**Reálné volání OpenAI API JE implementované** (`backend/ai/aiClient.js`'s
`openAiProvider`, official `openai` npm SDK) — otestováno v tomhle kroku
proti skutečnému `api.openai.com` (viz „Jak otestovat" níže), ne jen
teoreticky. Stejný bezpečnostní rámec jako předtím zůstal beze změny:

- `OPENAI_API_KEY` — poskytuje **výhradně majitel projektu**, žije jen
  v `backend/.env`, nikdy v kódu, nikdy ve frontendu, nikdy v commitu,
  nikdy v logu (jen `present: yes/no`, viz startup log a
  `GET /admin/ai/health`).
- `AI_ENABLED=false` (default) — AI endpoints vrátí `503 AI_DISABLED`,
  nic se nezkouší volat.
- `AI_MONTHLY_BUDGET_LIMIT=0` (default) — **druhý, nezávislý gate** na
  `OPENAI_API_KEY`. I s platným klíčem zůstává `AI_PROVIDER=openai`
  "not configured", dokud admin vědomě nenastaví kladný měsíční
  rozpočet. Obě podmínky musí platit zároveň — toto číslo je čistě
  informativní gate, **nesčítá skutečné utracené peníze** (žádné
  live-metering v tomhle kroku — sledujte skutečné útraty v OpenAI
  dashboardu).
- `AI_MODEL`/`OPENAI_MODEL` (default `gpt-4.1-mini`), `AI_TEMPERATURE`
  (default `0.2`), `AI_MAX_OUTPUT_TOKENS` (default `1200`) — ladění
  reálného volání, bezpečné výchozí hodnoty.
- Žádné automatické retry — jeden pokus, `30s` timeout, pak jasná chyba
  (401/429/`insufficient_quota`/timeout/…, viz níže), nikdy tichá smyčka.
- Každý AI výstup **pořád** vyžaduje human review (viz «AI orchestrator
  foundation» výše) — tahle podmínka se týká úplně stejně reálného i
  mock provideru, bez výjimky.

### Jak zapnout

```bash
# backend/.env
OPENAI_API_KEY=sk-proj-...        # z platformy OpenAI, nikdy necommitovat
AI_PROVIDER=openai
AI_ENABLED=true
AI_MONTHLY_BUDGET_LIMIT=20         # jakékoliv kladné číslo — jen gate, nesčítá útraty
```

### Jak otestovat

```bash
# 1) AI health — bez klíče v odpovědi, jen stav
curl -H "x-admin-password: VASE_HESLO" http://localhost:3001/admin/ai/health

# 2) testovací běh (report-kind agent, entityType vin_check s ručním inputem)
curl -X POST http://localhost:3001/admin/ai/run \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"agentName":"vin_risk_explanation","entityType":"vin_check","entityId":"vincheck_xxx",
       "input":{"vinCheck":{"vin":"...","riskLevel":"high","score":37,"accidents":2,"owners":2,"odometerRisk":"medium","isDemoResult":true}}}'

# 3) testovací běh (business-kind agent, agregát bez PII)
curl -X POST http://localhost:3001/admin/agents/run-business-agent \
  -H "Content-Type: application/json" -H "x-admin-password: VASE_HESLO" \
  -d '{"agentName":"admin_operations","entityType":"dashboard","entityId":"today"}'
```

### Jak vypnout / vrátit se k mock provideru

```bash
AI_PROVIDER=mock   # nebo AI_ENABLED=false úplně vypne AI endpointy
```
Nic jiného měnit netřeba — `backend/ai/aiClient.js`'s `mockAiProvider`
zůstal beze změny, deterministický, zdarma, offline.

### Chybové stavy (`openAiProvider`, nikdy nekonečný retry)

| Situace | Co backend vrátí |
|---|---|
| `OPENAI_API_KEY` chybí nebo `AI_MONTHLY_BUDGET_LIMIT<=0` | `503 PROVIDER_NOT_CONFIGURED`, jasně říká který ze dvou gate chybí |
| Neplatný klíč (401) | `502 PROVIDER_ERROR`: "OpenAI rejected the API key (401 Unauthorized)…" |
| `insufficient_quota` | `502 PROVIDER_ERROR`: "OpenAI reports insufficient quota/billing…" |
| Rate limit (429) | `502 PROVIDER_ERROR`: "OpenAI rate-limited this request…" |
| Timeout (30s) | `502 PROVIDER_ERROR`: "OpenAI request timed out after 30000ms." |
| Model nevrátil validní JSON / neodpovídá schématu | `400 INVALID_OUTPUT` |

### Rizika nákladů

`estimatedCost` u `openai` runů je **odhad podle veřejného ceníku**
(`OPENAI_PRICE_PER_1M_TOKENS_USD` v `aiClient.js`), NE skutečná faktura
— ceny se mění, účty mají různé tiery/slevy. Pro neznámý model vrací
upřímně "(unknown)". Skutečné útraty sledujte v OpenAI dashboardu;
`AI_MONTHLY_BUDGET_LIMIT` je jen gate, nezastaví utrácení samo o sobě
uprostřed měsíce.

### Architektura 19 agentů (14 implementováno, 5 plánováno)

| # | Agent | Stav | Poznámka |
|---|---|---|---|
| — | AI Orchestrator | ✅ implementován | základní infrastruktura, ne samostatný agent |
| 1 | VIN Report Agent | ✅ `vin_risk_explanation` | wave 1 |
| 2 | Listing Analysis Agent | ✅ `listing_analysis` | wave 1 |
| 3 | Buyer Advisor Agent | ✅ `buyer_advisor` | wave 1 |
| 4 | Price & Negotiation Agent | ⏳ plánován | rozšíření buyer_advisor o cenová jednání |
| 5 | Report Writer Agent | ✅ `report_writer` | wave 1 |
| 6 | Risk Scoring Agent | ✅ `risk_scoring` | wave 1 |
| 7 | Inspector Assistant Agent | ⏳ plánován | pomoc technikovi při fyzické prohlídce |
| 8 | Photo Review Agent | ⏳ plánován | **vyžaduje vision model — mimo scope, dokud není explicitně zadáno** |
| 9 | Dealer Trust Agent | ⏳ plánován | hodnocení důvěryhodnosti dealera |
| 10 | B2B Sales Agent | ✅ `b2b_sales` | wave 2 |
| 11 | Inspector Network Agent | ⏳ plánován | párování/správa sítě techniků |
| 12 | Email Support Agent | ✅ `support` | wave 2, nyní i entityType `email_log` |
| 13 | CRM Follow-up Agent | ✅ `crm_follow_up` | wave 2 |
| 14 | Payment Control Agent | ✅ `operations_payment` | wave 2 |
| 15 | Lead Qualification Agent | ✅ `lead_qualification` | wave 3 |
| 16 | Booking Coordinator Agent | ✅ `booking_coordinator_agent` | wave 3 |
| 17 | Admin Operations Agent | ✅ `admin_operations` | wave 3 |
| 18 | Revenue Share Agent | ✅ `revenue_share_agent` | wave 3, viz «Revenue-share 20%» |
| 19 | Business Growth Agent | ✅ `business_growth` | wave 3 |

Neměnná pravidla pro **všech** implementovaných i plánovaných (viz «AI
agents — wave 2/3» výše pro plné znění): žádné automatické odeslání
klientovi, žádné finanční operace, žádná změna payment statusu, žádný
slib 100% přesnosti, vždy jen návrh/report/task pro člověka — finální
akci vždy potvrzuje člověk. Plný katalog s `allowedActions`/
`forbiddenActions`/`systemPrompt`/`riskLevel` je vidět v
`GET /admin/ai/agents` a na `admin-ai-runs.html`.

## Production deployment

Пошаговая инструкция для реального сервера. Архитектура **честно как
есть**, без выдумывания: это два отдельных процесса — backend (Express,
слушает `PORT` из `.env`, по умолчанию `3001`) и frontend (статические
файлы, сейчас отдаются локально через `python3 -m http.server`, в
проде — любым статик-хостингом/nginx/Caddy). Фронтенд обращается к
backend по **полному абсолютному URL**, не по относительному `/api/...`.

### Frontend API base URL — единый runtime config

URL backend'а, который использует фронтенд, задаётся в **одном месте**:
`js/config.js`. Это обычный (не module) `<script>`, подключённый на
каждой странице, которой нужен backend (`index.html` и все шесть
`admin-*.html`), **перед** её основным `<script type="module">`:

```html
<script src="js/config.js"></script>
<script type="module" src="js/admin/admin-leads.js"></script>
```

`js/config.js` устанавливает `window.OVERENO_CONFIG.apiBaseUrl`, и все
пять файлов, которые раньше содержали хардкод (`js/api/api.js`,
`js/admin/admin-bookings.js`, `admin-payments.js`, `admin-email-logs.js`,
`admin-agents.js`), теперь читают URL именно оттуда:

```js
const API_BASE_URL = (window.OVERENO_CONFIG && window.OVERENO_CONFIG.apiBaseUrl)
  || 'http://localhost:3001';
```

**Локальная разработка:** ничего делать не нужно — `js/config.js` из
коробки указывает на `http://localhost:3001`, как и раньше.

**Production:** отредактировать **один файл**, `js/config.js`, задав
реальный URL backend'а:

```js
window.OVERENO_CONFIG = {
  apiBaseUrl: 'https://api.nexium.cz'
};
```

Готовый шаблон для копирования — `js/config.example.js` (не
подключается ни на одной странице сам по себе, это просто образец).
Скопируйте его содержимое в `js/config.js` на сервере, или сгенерируйте
`js/config.js` из этого шаблона в своём деплой-пайплайне — рабочий код
(`api.js`, `admin-*.js`) трогать не нужно вообще.

**`apiBaseUrl` — не секрет.** Это тот же URL, который и так виден
любому посетителю в Network tab браузера. Никогда не кладите в
`js/config.js` API-ключи, пароли или что-то ещё секретное — этот файл
отдаётся как обычный JavaScript всем посетителям сайта.

**Если `js/config.js` отсутствует или не загрузился** — каждый из
пяти файлов безопасно откатывается на тот же `http://localhost:3001`,
что и раньше. Ничего не падает, просто локальная разработка продолжает
работать как обычно.

**Как проверить, что фронтенд ходит в правильный backend:** откройте
DevTools → Network на реальном домене, отправьте любую форму (или
откройте любую `admin-*.html` и введите пароль) — запросы должны идти
на `apiBaseUrl` из `js/config.js`, а не на `localhost:3001`. Либо
проще — `curl https://nexium.cz/js/config.js` и прочитать значение
глазами.

### Обязательные env-переменные

| Переменная | Обязательна? | Что будет, если не задать |
|---|---|---|
| `ADMIN_PASSWORD` | Да | Работает с `change_me`, backend громко предупреждает |
| `CORS_ORIGINS` | Да (если фронтенд не на localhost) | Falls back на localhost-only, реальный домен получит CORS-ошибку в браузере |
| `PORT` | Нет | По умолчанию `3001` |
| `NODE_ENV` | Нет (чисто информационно) | По умолчанию считается `development` в логах |
| `APP_URL` | Да, если включён `EMAIL_ENABLED` или `PAYMENTS_ENABLED` | Ссылки в письмах и mock-checkoutUrl укажут на `localhost:8000` |
| `EMAIL_ENABLED` + `SMTP_*` | Нет (можно оставить выключенным) | По умолчанию `false` — email просто не отправляются, всё остальное работает |
| `PAYMENTS_ENABLED` + `PAYMENT_PROVIDER` + `STRIPE_*` | Нет (можно оставить mock/выключенным) | По умолчанию `false` — `POST /payments/checkout` отвечает понятной ошибкой вместо падения |

### Пример production `.env` (без секретов — вставьте свои значения)

```bash
PORT=3001
NODE_ENV=production
ADMIN_PASSWORD=<сгенерировать длинный случайный пароль>
CORS_ORIGINS=https://nexium.cz,https://www.nexium.cz
APP_URL=https://nexium.cz

EMAIL_ENABLED=true
SMTP_HOST=<ваш SMTP host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<ваш SMTP user>
SMTP_PASS=<ваш SMTP password>
FROM_EMAIL=no-reply@nexium.cz
FROM_NAME=NEXIUM
ADMIN_NOTIFICATION_EMAIL=admin@nexium.cz
EMAIL_LOGGING_ENABLED=true

# Оставьте PAYMENTS_ENABLED=false, пока не пройдёте Stripe test mode
# целиком (см. раздел «Платежи» выше) — сначала test-ключи, потом live.
PAYMENTS_ENABLED=false
PAYMENT_PROVIDER=mock
```

### Как запускать backend

```bash
cd backend
npm install --omit=dev   # только production-зависимости
npm start                 # node server.js, без --watch
```

`npm start` — обычный `node server.js`, без file-watcher (`--watch`
только у `npm run dev`, для локальной разработки). На реальном сервере
держите процесс живым через systemd/pm2/docker restart-policy — сам
`npm start` не демонизируется и не перезапускается при падении.

### Как отдавать frontend

Любой статик-хостинг подойдёт — это plain HTML/CSS/JS без сборки.
Например nginx, отдающий корень проекта (всё, кроме `backend/`) как
статику. Не забудьте после правки `js/config.js` (см. выше).

### Reverse proxy — nginx (пример)

Два отдельных сервер-блока — один для статики фронтенда, один для
backend API (соответствует текущей архитектуре с двумя доменами):

```nginx
# Frontend — статика
server {
    listen 443 ssl;
    server_name nexium.cz www.nexium.cz;

    ssl_certificate     /etc/letsencrypt/live/nexium.cz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nexium.cz/privkey.pem;

    root /var/www/overeno-web;
    index index.html;
}

# Backend API — проксируется на процесс Node на localhost:3001
server {
    listen 443 ssl;
    server_name api.nexium.cz;

    ssl_certificate     /etc/letsencrypt/live/api.nexium.cz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.nexium.cz/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

С этой схемой `apiBaseUrl` в `js/config.js` — `https://api.nexium.cz`,
а `CORS_ORIGINS=https://nexium.cz,https://www.nexium.cz`.

### Reverse proxy — Caddy (пример)

Caddy получает HTTPS-сертификаты автоматически, конфиг короче:

```caddyfile
nexium.cz, www.nexium.cz {
    root * /var/www/overeno-web
    file_server
}

api.nexium.cz {
    reverse_proxy 127.0.0.1:3001
}
```

### HTTPS

Backend сам TLS не терминирует — это всегда задача reverse proxy
(nginx/Caddy выше, или managed-балансировщик вроде Cloudflare/ALB).
`Strict-Transport-Security` заголовок backend отправляет всегда, но он
реально что-то даёт только если соединение и так идёт по HTTPS через
прокси. Caddy получает сертификаты автоматически (Let's Encrypt); для
nginx — `certbot`.

### Проверки после старта (дублируются в Deployment smoke checklist ниже, короткая версия здесь)

```bash
# health
curl https://api.nexium.cz/health

# CORS — с разрешённого домена в заголовке ответ содержит Access-Control-Allow-Origin
curl -H "Origin: https://nexium.cz" -D - https://api.nexium.cz/health -o /dev/null | grep -i access-control-allow-origin

# admin password всё ещё требуется
curl -o /dev/null -w "%{http_code}\n" https://api.nexium.cz/admin/leads   # ожидается 401

# rate limit всё ещё работает (31-й запрос за минуту -> 429)
for i in $(seq 1 31); do curl -s -o /dev/null -X POST https://api.nexium.cz/leads -H "Content-Type: application/json" -d '{"type":"final_cta","email":"x@example.com"}'; done

# путь к SQLite-базе — смотрите в логе процесса при старте: "database path: ..."
```

### Backup SQLite

```bash
cd backend
npm run backup:sqlite
```

Создаёт `backend/backups/overeno-<timestamp>.sqlite` через встроенный
online-backup API better-sqlite3 (`db.backup()`) — безопасно запускать,
пока сервер работает и пишет в базу (WAL-режим), это не сырое
копирование файла. Старые backup-файлы **не удаляются автоматически** —
это осознанное решение, ретеншн-политику настраиваете сами (cron +
`find backups/ -mtime +30 -delete`, например). Если базы ещё нет
(свежая установка, сервер ни разу не запускался) — скрипт честно
сообщает об этом и ничего не создаёт.

Автоматизация: добавьте `npm run backup:sqlite` в cron на сервере,
например ежедневно ночью.

### Restore SQLite из backup

Сервер должен быть остановлен (или хотя бы не писать в базу в этот
момент — иначе рискуете затереть данные, записанные после backup):

```bash
cd backend
# остановите процесс backend
cp backups/overeno-<нужный-timestamp>.sqlite data/overeno.sqlite
rm -f data/overeno.sqlite-wal data/overeno.sqlite-shm   # если остались от старого запуска
# запустите backend заново — restore проверен end-to-end на этом этапе
```

### Как не включить WAL/SHM в деплой/архив

`backend/data/overeno.sqlite-wal` и `-shm` — временные файлы WAL-режима
SQLite, создаются автоматически при каждом запуске сервера и не
предназначены для копирования/архивирования отдельно от `.sqlite`
(и уж точно не для коммита в git или включения в zip-архив проекта).
При упаковке этого проекта они всегда явно исключаются (`-x
"*.sqlite-wal" -x "*.sqlite-shm"`, см. также `.gitignore`, если он
есть в вашем репозитории). Backup-скрипт выше их тоже не трогает — он
бэкапит через SQLite backup API, а не копированием файлов.

### Перед первым реальным запуском

1. Задать `apiBaseUrl` в `js/config.js` (см. начало раздела) — один файл.
2. Пройти по `.env` — см. таблицу обязательных переменных выше.
3. Пройти по «Production checklist» ниже целиком.
4. Пройти по «Deployment smoke checklist» ниже после первого деплоя.

## Production checklist

Ничего из этого не включено/не активировано по умолчанию — сайт
работает "из коробки" в safe/demo-режиме специально, чтобы ничего не
сломать при первом запуске. Перед реальным использованием пройдите
по списку:

- [ ] **`ADMIN_PASSWORD`** — задать в `backend/.env`, не оставлять
      `change_me`. Backend громко предупреждает в консоли при старте,
      если это не сделано.
- [ ] **`APP_URL`** — указать реальный домен фронтенда (используется в
      ссылках внутри email-уведомлений и в mock-платёжном `checkoutUrl`).
- [ ] **SMTP** — настроить `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`
      и включить `EMAIL_ENABLED=true`. Проверить сначала через тестовый
      SMTP (см. раздел «Email-уведомления» выше), потом только через
      реальный провайдер. Backend теперь предупреждает при старте, если
      `EMAIL_ENABLED=true`, а `SMTP_HOST` не задан — не ждите первой
      попытки отправки, чтобы это заметить.
- [ ] **Stripe** (если нужны реальные платежи, не только mock) —
      `PAYMENT_PROVIDER=stripe`, реальные `STRIPE_SECRET_KEY`/
      `STRIPE_WEBHOOK_SECRET` в **test mode сначала**, полный цикл
      checkout→webhook проверить вручную, и только потом live-ключи.
      `stripeProvider.js` в этом проекте **не проверялся** на реальном
      Stripe-аккаунте — это reviewed-but-unverified код (см. раздел
      «Платежи» выше).
- [ ] **`DEV_MOCK_FALLBACK`** — выставить `false` в `js/api/api.js`
      (сейчас `true`). Иначе упавший backend в проде будет незаметно
      подменяться клиентским mock'ом вместо явной ошибки. Backend не
      может проверить это за вас (это фронтенд-константа) — стартовый
      лог всегда печатает напоминание проверить её вручную.
- [ ] **Backup SQLite** — `backend/data/overeno.sqlite` это единственная
      копия всех данных. `npm run backup:sqlite` (см. раздел «Backup
      SQLite» выше) — безопасно запускать, пока сервер работает.
      WAL/SHM-файлы (`*.sqlite-wal`, `*.sqlite-shm`) — временные, в
      backup и в архив проекта их включать не нужно.
- [ ] **`CORS_ORIGINS`** — задать в `backend/.env` реальный домен
      фронтенда (через запятую, если доменов несколько), например
      `CORS_ORIGINS=https://nexium.cz,https://www.nexium.cz`. Без
      этого используется безопасный localhost-only fallback — сайт с
      реального домена не сможет обращаться к API. Backend при старте
      предупреждает в консоли, если список всё ещё localhost-only.
- [ ] **`NODE_ENV=production`** — чисто информационно (ни на что не
      влияет в коде), но стартовый лог печатает это значение — полезно
      для быстрой проверки "точно ли это прод-процесс".
- [ ] **HTTPS за прокси** — сам backend не терминирует TLS. За реверс-прокси
      (nginx/Caddy/Cloudflare и т. п.) — обычная практика. `Strict-Transport-Security`
      заголовок уже отправляется всегда, но реально работает только
      если соединение и правда идёт по HTTPS.
- [ ] **Smoke-тесты** — см. полный список ниже, в разделе «Deployment
      smoke checklist».

## Deployment smoke checklist

Прогнать вручную сразу после каждого реального деплоя (не только
первого) — дёшево и ловит "забыл переменную окружения" / "прокси
неправильно настроен" до того, как это заметит реальный пользователь.
Замените `https://api.nexium.cz` и `https://nexium.cz` на ваши
реальные домены.

```bash
# 1. Backend жив
curl -i https://api.nexium.cz/health

# 2. Публичные POST-эндпоинты принимают запросы
curl -i -X POST https://api.nexium.cz/leads -H "Content-Type: application/json" \
  -d '{"type":"final_cta","email":"smoke-test@example.com"}'
curl -i -X POST https://api.nexium.cz/bookings -H "Content-Type: application/json" \
  -d '{"city":"Praha","preferredSlot":"smoke-test","email":"smoke-test@example.com"}'
curl -i -X POST https://api.nexium.cz/vin/check -H "Content-Type: application/json" \
  -d '{"vin":"TMBJJ7NX0K0123456"}'

# 3. Платежи — ТОЛЬКО если PAYMENTS_ENABLED=true. С mock-провайдером
#    или Stripe test mode, никогда live на смоук-тесте:
curl -i -X POST https://api.nexium.cz/payments/checkout -H "Content-Type: application/json" \
  -d '{"productCode":"vin_basic_report","entityType":"vin_check"}'

# 4. CORS с реального домена фронтенда
curl -H "Origin: https://nexium.cz" -D - https://api.nexium.cz/health -o /dev/null \
  | grep -i access-control-allow-origin   # должна быть строка с вашим доменом

# 5. Security headers на месте
curl -D - https://api.nexium.cz/health -o /dev/null \
  | grep -iE "x-content-type-options|x-frame-options|strict-transport-security"

# 6. Rate limit всё ещё работает (31-й запрос за минуту -> 429)
for i in $(seq 1 31); do
  curl -s -o /dev/null -w "%{http_code} " -X POST https://api.nexium.cz/leads \
    -H "Content-Type: application/json" -d '{"type":"final_cta","email":"rl-test@example.com"}'
done
echo   # последнее число в строке должно быть 429

# 7. Admin по-прежнему требует пароль, и с ним работает
curl -o /dev/null -w "%{http_code}\n" https://api.nexium.cz/admin/leads          # 401
curl -o /dev/null -w "%{http_code}\n" -H "x-admin-password: ВАШ_ПАРОЛЬ" \
  https://api.nexium.cz/admin/leads                                              # 200

# 8. CSV export работает и требует пароль
curl -o /dev/null -w "%{http_code}\n" https://api.nexium.cz/admin/leads/export.csv        # 401
curl -o /dev/null -w "%{http_code}\n" -H "x-admin-password: ВАШ_ПАРОЛЬ" \
  https://api.nexium.cz/admin/leads/export.csv                                             # 200
```

Плюс вручную в браузере, с реального фронтенд-домена:

- [ ] Лендинг `https://nexium.cz` открывается, VIN-demo/формы работают.
- [ ] `admin-leads.html` — вход с реальным паролем, список загружается.
- [ ] `admin-bookings.html` — то же самое.
- [ ] `admin-vin-checks.html` — то же самое.
- [ ] `admin-payments.html` — то же самое (если платежи включены).
- [ ] `admin-email-logs.html` — то же самое.
- [ ] `admin-agents.html` — то же самое.
- [ ] Ни один `admin-*.html` не открывается без пароля.
- [ ] `https://nexium.cz/backend/`, `.../.env`, `.../data/overeno.sqlite`
      и подобные пути **не отдаются** статик-сервером — только файлы из
      корня проекта, минус `backend/` целиком (см. ниже).

### Отсутствие секретов/служебных файлов в публичной статике

Если frontend раздаётся из корня всего репозитория (а не из отдельной
специально выделенной папки), убедитесь, что веб-сервер **не отдаёт**
`backend/` вообще — там `.env` с секретами (если случайно не исключён
из деплоя) и SQLite-база с реальными данными пользователей. Простейшая
защита — деплоить frontend и backend в физически разные директории
(или explicit deny-правило в nginx/Caddy на `/backend/*`), а не
полагаться только на то, что фронтенд-код на эти файлы не ссылается.

```bash
# Проверка с реального домена — все три должны вернуть 404, не 200
curl -o /dev/null -w "%{http_code}\n" https://nexium.cz/backend/.env
curl -o /dev/null -w "%{http_code}\n" https://nexium.cz/backend/data/overeno.sqlite
curl -o /dev/null -w "%{http_code}\n" https://nexium.cz/backend/node_modules/
```

## Final smoke checklist (все 12 этапов)

Исходный «Deployment smoke checklist» выше писался до появления AI/VIN
provider/inspector/dealer workflow — этот раздел его дополняет, а не
заменяет: прогоните оба после реального деплоя. Полный порядок — от
самого базового (backend жив) до самого специфичного (dealer badge).
Каждый пункт был вживую прогнан на этом launch-prep этапе (см. финальный
отчёт) — сюда скопирован в форме, готовой для повторения на реальном
сервере. Замените `https://api.nexium.cz` на ваш реальный backend URL.

- [ ] **1. Lead submit** — `POST /leads` с `type:"final_cta"` → `201`,
      появляется в `admin-leads.html`.
- [ ] **2. Booking submit** — `POST /bookings` → `201`, появляется в
      `admin-bookings.html`.
- [ ] **3. VIN check** — `POST /vin/check` → `201`, `result.isDemoResult:
      true` всегда (это demo, не реальный provider — см. «Real VIN
      provider adapter» выше).
- [ ] **4. Payment checkout** — `POST /payments/checkout` (только если
      `PAYMENTS_ENABLED=true`) → `201`, возвращает `checkoutUrl`.
- [ ] **5. Webhook paid + идемпотентность** — тот же webhook event
      (той же `providerSessionId`) дважды подряд → второй раз `paidAt`
      **не меняется**, email (если включён) **не** уходит повторно:
      ```bash
      curl -X POST https://api.nexium.cz/payments/webhook -H "Content-Type: application/json" \
        -d '{"type":"payment.paid","providerSessionId":"<ID>"}'
      curl -X POST https://api.nexium.cz/payments/webhook -H "Content-Type: application/json" \
        -d '{"type":"payment.paid","providerSessionId":"<ID>"}'   # повторно — paidAt тот же
      ```
- [ ] **6. Report created** — после paid webhook для `vin_basic_report`/
      `manual_car_review` в `admin-reports.html` появляется новый report
      со status `created`, дефолтными секциями.
- [ ] **7. Report builder** — в `admin-reports.html` → Sections
      редактируется контент секции, `draft_ready`/`report_ready` требуют
      непустых обязательных секций (проверено блокировкой перехода).
- [ ] **8. Report public token** — «Generate public token» → `GET
      /reports/public/<TOKEN>` без пароля отдаёт **только** safe-поля
      (без `internalNote`/`customerEmail`); «Revoke» → тот же токен `410`.
- [ ] **9. Report email delivery** — «Send to customer» (только с
      `EMAIL_ENABLED=true`) → запись в `admin-email-logs.html`, статус
      `report_sent` только если письмо реально ушло (честно, не
      предполагается).
- [ ] **10. AI run** — `admin-ai-runs.html`/AI-панель в
      `admin-reports.html` (только `AI_ENABLED=true`) → run создаётся,
      `AI_PROVIDER=mock` — детерминированный офлайн-результат, без
      сетевого вызова.
- [ ] **11. AI apply to report** — approve run → «Apply to report» →
      секция/score/riskLevel реально обновляются в report, **только**
      после approve (reject/pending → apply отклоняется `400`).
- [ ] **12. Inspector job** — `admin-bookings.html` на paid booking →
      «Create inspection job» → job в `admin-inspection-jobs.html`,
      чеклист создаётся, статус меняется вручную.
- [ ] **13. Dealer badge** — dealer со статусом `verified` → vehicle →
      «Request badge» → admin approve → `GET /badges/public/<CODE>`
      без пароля отдаёт честный статус + safe-поля (без
      `internalNote`/`email`/`contactName`).
- [ ] **14. Admin CSV exports** — по одному на каждую из 13
      admin-страниц (`leads`/`bookings`/`vin-checks`/`payments`/
      `email-logs`/`agents`/`reports`/`ai-runs`/`agent-tasks`/
      `inspectors`/`inspection-jobs`/`dealers`/`badges`) — каждый `200`
      с паролем, `401` без.
- [ ] **15. Backup** — `npm run backup:sqlite` создаёт файл в
      `backend/backups/`, безопасно во время работающего сервера.
- [ ] **16. Restore** — остановить сервер, скопировать backup поверх
      `data/overeno.sqlite`, удалить `-wal`/`-shm`, запустить заново —
      данные на месте (см. «Restore SQLite из backup» выше).
- [ ] **17. CORS** — запрос с недопустимого Origin **не** получает
      `Access-Control-Allow-Origin` в ответе; запрос с домена из
      `CORS_ORIGINS` — получает.
- [ ] **18. Rate limit** — 31-й запрос за минуту на один и тот же
      публичный write-эндпоинт с одного IP → `429`.

## Production risk matrix

Честная оценка того, что может пойти не так на реальном запуске, и что
с этим делать. Ничего здесь не блокирует запуск само по себе — но
каждый пункт стоит осознанно принять, а не открыть для себя после
инцидента.

| Риск | Вероятность | Последствия | Как проверить | Как снизить |
|---|---|---|---|---|
| **SQLite — один процесс** | Средняя (при росте нагрузки) | При нескольких backend-процессах/серверах — рассинхрон данных, возможна потеря записей | Смотреть `NODE_ENV`/деплой — работает ли больше одного процесса backend'а одновременно на одном `data/overeno.sqlite` | Один процесс backend на деплой (см. «Известные ограничения»); при реальном росте — миграция на PostgreSQL |
| **Admin — общий пароль, не полноценная auth** | Высокая (со временем) | Утечка пароля = полный доступ ко всем данным, без возможности отозвать доступ одному человеку, не всем | Проверить, кто знает `ADMIN_PASSWORD` и как он передаётся/хранится | Длинный случайный пароль, ротация при увольнении/подозрении в утечке, HTTPS всегда (пароль идёт в заголовке) |
| **Stripe live не проверен** | Высокая (если включить live без теста) | Реальные платежи могут не пройти/не записаться корректно — `stripeProvider.js` reviewed-but-unverified | Полный цикл checkout→webhook в **test mode** до единого live-ключа | Обязательно test mode сначала (см. «Production checklist» выше), не пропускать |
| **VIN provider (Vincario) — cost/API риск** | Средняя (если `VIN_PROVIDER=real` включён с рабочими ключами) | Реальный вызов Vincario стоит кредитов за каждый запрос; `costEstimate` честно "(unknown)" — код не знает реальный тариф аккаунта | `VIN_PROVIDER`/`VIN_PROVIDER_ENABLED` в `.env`, смотреть `vin_provider_runs.costEstimate` | `VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK=true` (default), rate limit на `run-provider`, `VIN_PROVIDER_ENABLED=false` — мгновенный откат на demo |
| **AI (OpenAI) hallucination / стоимость** | Средняя (`AI_PROVIDER=openai` реализован и протестирован) | AI-вывод может содержать неточности/выдумки; `AI_MONTHLY_BUDGET_LIMIT` — только gate, не лимит фактических трат (см. «Известные ограничения») | Смотреть `GET /admin/ai/health`, реальные траты — только в OpenAI dashboard | Human review обязателен для каждого run (не отключается), apply-to-report — только после approve; `AI_MONTHLY_BUDGET_LIMIT=0` мгновенно блокирует реальные вызовы |
| **Email deliverability** | Средняя | Письма могут попадать в спам/не доходить — `emailService.js` не проверялся на реальном SMTP-провайдере | `admin-email-logs.html` — смотреть статус каждой попытки | Тестовый SMTP (Mailtrap/аналог) перед реальным провайдером, SPF/DKIM на домене отправителя, мониторинг `email_logs` |
| **Утечка public token/badge code** | Низкая | Report token/badge code, если он попал не в те руки, даёт доступ к конкретной записи (не ко всей системе) | Report token — 64 hex символа, revocable; badge code — 10 символов, публично-делимый по дизайну | Report: «Revoke» на `admin-reports.html` при подозрении на утечку; badge: revoke на `admin-badges.html`. Ни то ни другое не даёт доступа к чему-либо ещё |
| **Backup failure** | Средняя (если забыть настроить) | Единственная копия данных — `backend/data/overeno.sqlite`; без backup потеря файла = потеря всех данных | `npm run backup:sqlite` вручную, проверить, что `backend/backups/` реально растёт | Cron на `npm run backup:sqlite` (ежедневно минимум), хранить backup **вне** того же диска/сервера |
| **CORS misconfig** | Средняя (частая ошибка при деплое) | Слишком широкий `CORS_ORIGINS` — XSS-подобный риск через сторонний сайт; слишком узкий — фронтенд не работает | Curl-тест из smoke checklist выше (пункт 17) | Точный список доменов в `CORS_ORIGINS`, никогда `*`, backend уже предупреждает при старте если localhost-only |
| **Нет WAF/reverse proxy** | Высокая (если не настроено) | In-memory rate limiter — это не защита от серьёзного DDoS/ботов, только базовая защита от одиночного клиента | Смотреть, стоит ли nginx/Cloudflare/аналог перед backend | nginx/Caddy как reverse proxy (пример конфига выше) + Cloudflare/аналог для реального анти-DDoS перед боевым трафиком |

## Launch mode config

Что обязано быть «real» перед реальным запуском, что можно/нужно
оставить demo/mock, и что категорически нельзя включать без полного
теста.

**Обязательно real перед реальным запуском:**
- `ADMIN_PASSWORD` — длинный случайный, не `change_me`.
- `CORS_ORIGINS` — реальный домен(ы) фронтенда.
- `APP_URL` — реальный домен (используется в email-ссылках и mock
  checkoutUrl).
- `NODE_ENV=production` (информационно, но должно отражать реальность).
- `DEV_MOCK_FALLBACK=false` в `js/api/api.js` (см. «Production
  checklist» выше — единственный чисто фронтенд-флаг в этом списке).

**Можно оставить demo/mock на бете, включить позже:**
- `EMAIL_ENABLED=false` — сайт полностью работает без email, письма
  просто не уходят.
- `PAYMENTS_ENABLED=false` / `PAYMENT_PROVIDER=mock` — можно собирать
  лиды/бронирования без реальных платежей.
- `AI_ENABLED=false` — весь AI-функционал (wave 1 + wave 2/3) выключен,
  ничего не ломается.
- `VIN_PROVIDER=demo` — единственный режим, который использует
  **публичная** форма (`POST /vin/check`), независимо от этой
  переменной. Остаётся безопасным выбором даже на реальном запуске,
  если честность demo-статуса перед клиентом это устраивает.

**Теперь реально реализовано (протестировано против живых API в этом
шаге — см. «Vincario adapter» и «GPT API readiness» выше для деталей,
ошибок и как включить):**
- `VIN_PROVIDER=real` + `VIN_PROVIDER_ENABLED=true` + Vincario-ключи —
  реальный вызов `api.vincario.com` (только через admin-only
  `run-provider`, никогда из публичной формы, и только для оплаченного
  `vin_check`, если `VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK=true`). Vincario
  отдаёт только технические характеристики (марка/модель/год/двигатель),
  не историю ДТП/пробега — это отдельный платный продукт Vincario, тут
  не вызывается.
- `AI_PROVIDER=openai` + `OPENAI_API_KEY` + `AI_MONTHLY_BUDGET_LIMIT>0` —
  реальный вызов `api.openai.com`. `anthropic` (или другое имя)
  по-прежнему просто вернёт `PROVIDER_NOT_CONFIGURED`, ничего не
  сломает.

**Категорически запрещено в production без полного отдельного теста:**
- `PAYMENT_PROVIDER=stripe` с `sk_live_...` **до** полного прохода
  test mode целиком (checkout→webhook→запись в БД→email) — см.
  Production checklist.
- `VIN_PROVIDER=real` с настоящими Vincario-ключами **до** проверки их
  ToS (кэширование/хранение `vin_provider_runs.responseJson`) для вашего
  конкретного тарифа/использования — см. «Vincario adapter» выше.
- `AI_PROVIDER=openai` без реалистичного `AI_MONTHLY_BUDGET_LIMIT` и без
  мониторинга реальных трат в OpenAI dashboard — это число тут только
  gate, не лимит фактических трат.
- Любой `ADMIN_PASSWORD`, который используется где-то ещё (переиспользование
  паролей) — это единственный ключ ко всем данным системы.

## Rollback plan

Как откатиться на каждом уровне, от простого к серьёзному.

**Откатить zip-архив (код откатился, данные — отдельный вопрос ниже):**
```bash
# Остановить текущий backend-процесс, затем:
rm -rf overeno-web-current   # или как называется текущая рабочая копия
unzip overeno-web-previous.zip -d overeno-web-current
cd overeno-web-current/backend && npm install --omit=dev && npm start
```
Код и SQLite-схема разные вещи — откат кода **не** откатывает данные в
`data/overeno.sqlite` (миграции в `schema.js` всегда только
добавляют колонки, никогда не удаляют, так что более старый код
обычно продолжает работать с более новой БД, но не наоборот, если
новый код уже написал данные в колонки, которых старый код не знает).

**Восстановить SQLite из backup:** см. «Restore SQLite из backup» выше
— остановить сервер, скопировать backup-файл поверх `data/overeno.sqlite`,
удалить `-wal`/`-shm`, запустить заново.

**Отключить платежи** (не трогая остальной сайт): `PAYMENTS_ENABLED=false`
в `.env`, перезапустить backend. `POST /payments/checkout` начнёт
отвечать понятной ошибкой, всё остальное (лиды/бронирования/VIN/admin)
продолжает работать без изменений.

**Отключить AI:** `AI_ENABLED=false` в `.env`, перезапустить. Оба
endpoint'а (`/admin/ai/run`, `/admin/agents/run-business-agent`)
начнут отвечать `503 AI_DISABLED`. Уже существующие `ai_agent_runs`/
`agent_tasks` остаются в БД и доступны для просмотра, просто новые
run'ы не создаются.

**Отключить real VIN provider:** `VIN_PROVIDER=demo` в `.env`,
перезапустить. `POST /admin/vin-checks/:id/run-provider` начнёт
отвечать понятной ошибкой («nothing to run с demo»), публичный
`POST /vin/check` не меняется вообще (он и так всегда использовал
demo, независимо от этой переменной).

**Вернуться на mock (платежи):** `PAYMENT_PROVIDER=mock` в `.env`,
перезапустить — checkout начнёт возвращать mock `checkoutUrl` вместо
похода в Stripe. Existing paid-записи не меняются, просто новые
checkout'ы идут через mock.

**Отключить revenue-share:** `PATCH /admin/revenue-share/settings` с
`{"enabled":false}` (или напрямую в admin UI) — новые paid платежи
перестанут попадать в ledger. Уже существующие ledger/payout записи
остаются нетронутыми, ничего не удаляется.

**Заблокировать реальный GPT/OpenAI вызов принудительно:**
`AI_MONTHLY_BUDGET_LIMIT=0` в `.env` (уже default) — независимо от
наличия `OPENAI_API_KEY`, `AI_PROVIDER=openai` остаётся
"not configured". Работает даже если кто-то по ошибке проставил
реальный ключ.

Во всех семи случаях выше — просто смена значения в `.env` (или
одного PATCH-запроса для revenue-share) +
перезапуск процесса, без изменения кода и без отката SQLite. Это
самый быстрый откат из всех, и он никогда не теряет уже записанные
данные.

## Известные ограничения (осознанно, для следующих этапов)

- Хранилище — SQLite, один файл (`overeno.sqlite`), без отдельного сервера
  БД. Подходит для MVP и умеренной нагрузки одного backend-процесса;
  при нескольких процессах/серверах backend одновременно понадобится
  PostgreSQL или аналог.
- `POST /vin/check` — **demo-результат**, не подключение к реальному
  провайдеру данных об истории автомобиля. Число всегда одно и то же
  для одного VIN, но не основано на реальных данных о конкретном
  автомобиле.
- У VIN-проверок есть только `PATCH .../note` (внутренняя заметка) —
  ни смены статуса, ни DELETE по-прежнему нет, осознанно.
- **Vincario (реальный VIN provider) отдаёт только технические
  характеристики** (марка/модель/год/двигатель/…), не историю ДТП,
  пробег или владельцев — это отдельный платный VHR-продукт Vincario,
  который тут не вызывается. Ключи из `.env.txt`, с которыми это
  тестировалось, Vincario отклонил как `Invalid Control sum` на трёх
  разных реальных VIN — похоже на пример-заглушку из документации, не
  на реальный оплаченный аккаунт; нужен свой ключ из Vincario dashboard.
- **`AI_MONTHLY_BUDGET_LIMIT` — это только gate, не счётчик фактических
  трат.** Ничего в этом коде не суммирует реальные OpenAI-расходы за
  месяц и не останавливает вызовы при их превышении — только сам
  OpenAI-аккаунт (свои usage limits в OpenAI dashboard) может это
  ограничить по-настоящему.
- **Найдено на launch-prep этапе**: `GET /admin/agents` не имеет
  `/export.csv` — единственная admin-таблица из 13 без CSV-экспорта.
  Не критично (agents — маленький внутренний справочник, не растущий
  бизнес-объект вроде leads/payments), но честно фиксируем как пробел,
  а не тихо чиним — добавление нового endpoint'а на этом этапе было бы
  новой фичей, что этому шагу прямо запрещено.
- Admin-доступ — одно общее пароль-значение в заголовке, без
  пользователей/ролей/сессий. Достаточно для одного администратора на
  первом этапе, не годится как реальная multi-user auth-система. Таблица
  `agents` это **не меняет** — это бизнес-данные (кому что назначено), не
  логины; кто угодно с `ADMIN_PASSWORD` видит и меняет всё, независимо
  от того, кому что назначено.
- Агентам не приходят email-уведомления при назначении — задокументировано
  как следующий этап, не реализовано сейчас (см. «Что это НЕ такое» выше).
- Нет привязки роли агента к тому, что ему МОЖНО назначать — сейчас любой
  агент любой роли технически назначаем на любую сущность (role — это
  просто маркировка/фильтр, не enforcement).
- Назначение техника на заявку — не автоматизировано, admin просто
  отмечает статус вручную после звонка/договорённости.
- Email — только уведомления о новых записях (lead/booking/vin-check),
  без писем о смене статуса, без email-маркетинга, без шаблонизатора
  сложнее простых html/text строк.
- VIN-проверка не собирает email пользователя — уведомление пользователю
  по VIN-check физически некому отправлять, пока это не изменится в форме.
- Платежи — sandbox/test-фундамент, **не production billing**: нет
  idempotency-ключей на исходящих запросах к провайдеру, нет retry-логики
  для недоставленных вебхуков. (Входящий `POST /payments/checkout` сам по
  себе теперь rate-limited — см. ниже, — но это не то же самое, что
  idempotency/retry для запросов К провайдеру.) Связь payment→booking/
  vin_check уже есть (см. «Связь оплаты» выше), но только для двух
  конкретных productCode — `manual_car_review` пока ни к чему не
  привязывается. `stripeProvider.js` не проверен на реальном
  Stripe-аккаунте (нет сети/ключей в этой среде).
- Rate limiting — есть базовый (30 запросов/минуту на IP на каждый из
  `POST /leads`, `/bookings`, `/vin/check`, `/payments/checkout`), но он
  **в памяти процесса**: сбрасывается при рестарте и не координируется
  между несколькими backend-процессами (тот же принцип, что и у
  однопроцессного SQLite). Для реальной защиты от abuse на публичном
  домене нужен ещё rate limiting на уровне reverse proxy/WAF.
- Security headers — базовый набор (`X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`)
  написан вручную, не через `helmet`. Осознанно минимально: это JSON API
  без серверного рендеринга HTML из пользовательского ввода, полный CSP
  тут не так критичен, как для сайта, который рендерит чужой контент.
- Нет SMS, AI — этого этапа они не касаются.
- CORS по умолчанию разрешён только для localhost dev-портов, пока в
  `.env` не задан `CORS_ORIGINS` (см. раздел «CORS» выше). Нет
  wildcard-режима ни при каких обстоятельствах — сознательно, чтобы
  нельзя было случайно открыть API всем подряд.

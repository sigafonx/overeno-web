# NEXIUM — web-project structure

Изначально — чистый рефакторинг структуры одностраничного `overeno.html`
на компоненты (дизайн и тексты не менялись). С тех пор поэтапно
добавлен реальный backend для лидов, bookings и VIN-проверок (`backend/`),
хранилище в SQLite, email-уведомления, sandbox-платежи (mock/Stripe test
mode, с автосвязкой успешной оплаты с booking/vin_check через webhook),
агенты и назначение ответственных (`admin-agents.html` + поле
`assignedAgentId` на leads/bookings/vin-checks/payments), report
workflow для оплаченных VIN-report/manual-review заказов
(`admin-reports.html` — статусы `created → in_review → draft_ready →
report_ready → report_sent → completed`, автосоздание после
`payment.paid`, полная история переходов) + manual report builder
поверх него (таблица `report_sections`, автосоздание default-секций по
типу отчёта, редактирование/reorder/reset, admin-only preview,
блокировка перехода в `draft_ready`/`report_ready`, пока обязательные
секции пустые) + secure report delivery поверх этого (приватная ссылка
`report.html?token=...`, 64-символьный crypto-случайный токен,
generate/revoke/send-to-customer в admin UI, публичный
`GET /reports/public/:token` без пароля, отдающий только safe-поля —
без internalNote/customerEmail/истории статусов) + AI orchestrator
foundation (`backend/ai/` — registry на 5 агентов, `ai_agent_runs`/
`ai_prompts`, `admin-ai-runs.html`) + **AI agents wave 1** поверх него:
все 5 агентов (listing_analysis/risk_scoring/report_writer/
buyer_advisor/vin_risk_explanation) теперь реально отдают структурированный
JSON строго по заданной схеме через deterministic mock provider,
backend сам собирает безопасный контекст отчёта (без internalNote/PII),
inline AI-панель прямо в `admin-reports.html` (запустить агента →
увидеть JSON → approve/reject → apply). Apply — **единственное** место,
куда AI-вывод может попасть в отчёт, и работает только для approved
run'ов (`POST /admin/ai/runs/:id/apply`, с понятной per-agent картой:
report_writer переписывает секции, risk_scoring — score/riskLevel,
остальные три — дописывают в конкретную существующую секцию) + **real
VIN provider adapter** (`backend/vin/` — demo/real/mock_real через
единый интерфейс, `vin_provider_runs` для полного audit trail; публичный
`POST /vin/check` всегда использует demo независимо от `VIN_PROVIDER`,
реальный/симулированный provider запускается только из админки после
оплаты — `VIN_REQUIRE_PAYMENT_FOR_REAL_CHECK=true` блокирует платные
вызовы для неоплаченных проверок; никакого реального VIN-провайдера в
этом шаге не выбрано и не подключено — честно задокументировано) +
**AI agents wave 2** (`crm_follow_up`/`b2b_sales`/`support`/
`operations_payment` — таблица `agent_tasks`, статус
`open → reviewed → completed/dismissed` сам по себе и есть human-review;
агенты НИКОГДА не отправляют сообщения, не меняют статус платежа и
ничего не удаляют — только предлагают действие и draft-текст; 3 кнопки
интеграции в admin-leads/admin-bookings/admin-payments +
`admin-agent-tasks.html` с ручным запуском любого из 4 агентов). Девять
admin-панелей
(`admin-leads.html`, `admin-bookings.html`, `admin-vin-checks.html`,
`admin-email-logs.html`, `admin-payments.html`, `admin-agents.html`,
`admin-reports.html`, `admin-ai-runs.html`, `admin-agent-tasks.html` —
все связаны друг с другом навигацией) + **inspector workflow**
(`inspectors`/`inspection_jobs`/`inspection_checklist_items` — базовый
admin-managed процесс физического осмотра: без логина техника, без
marketplace, без автоматических выплат — только текстовый чеклист и
ручное управление статусом; booking.status теперь реально использует
`inspector_needed`/`inspector_assigned`/`inspection_scheduled`,
которые уже были в его словаре статусов, но раньше не выставлялись
кодом; кнопка «Create inspection job» на `admin-bookings.html` доступна
только для paid-заказов) + **dealer workflow** (`dealers`/
`dealer_vehicles`/`verified_badges` — профиль автосалона, его
автомобили, и «verified» badge; badge никогда не выдаётся автоматически
— двойной admin-gate: dealer должен быть `verified`, и саму заявку
`requested→approved` двигает только admin; `expired` наступает только
автоматически по дате, вручную его выставить нельзя; публичная
`badge.html?code=...` показывает только safe-поля — никогда
internalNote/email/phone/contactName; без dealer-логина, без
marketplace, без subscription/recurring платежей). Тринадцать
admin-панелей
(`admin-leads.html`, `admin-bookings.html`, `admin-vin-checks.html`,
`admin-email-logs.html`, `admin-payments.html`, `admin-agents.html`,
`admin-reports.html`, `admin-ai-runs.html`, `admin-agent-tasks.html`,
`admin-inspectors.html`, `admin-inspection-jobs.html`,
`admin-dealers.html`, `admin-badges.html` — все связаны друг с другом
навигацией). Плюс
production hardening: security headers, базовый rate limiting на
публичных write-эндпоинтах, полный Production checklist в
`backend/README.md` — без новых бизнес-фич, только укрепление того, что
уже было. Все три frontend-функции (`submitLead`, `createBooking`,
`checkVin`) реально ходят в backend — mock остался только как fallback
на случай, если
backend не запущен.

## Быстрый старт

**1. Backend** (в одном терминале):
```bash
cd backend
cp .env.example .env
# откройте .env и задайте свой ADMIN_PASSWORD
npm install
npm run dev
```
Слушает `http://localhost:3001`.

**2. Frontend** (в другом терминале, из корня проекта):
```bash
python3 -m http.server 8000
```

**3. Открыть:**
- Лендинг — `http://localhost:8000`
- Админка лидов — `http://localhost:8000/admin-leads.html` (пароль — тот же `ADMIN_PASSWORD` из `backend/.env`)
- Админка bookings — `http://localhost:8000/admin-bookings.html` (тот же пароль)
- Админка VIN-проверок (read-only + interní poznámka) — `http://localhost:8000/admin-vin-checks.html` (тот же пароль)
- Админка email-логов (read-only + review) — `http://localhost:8000/admin-email-logs.html` (тот же пароль)
- Админка платежей (read-only + interní poznámka) — `http://localhost:8000/admin-payments.html` (тот же пароль)
- Админка агентов — `http://localhost:8000/admin-agents.html` (тот же пароль)
- Админка reports (workflow оплаченных заказов) — `http://localhost:8000/admin-reports.html` (тот же пароль)

Между всеми пятью admin-страницами есть простая навигация вверху.

По умолчанию `EMAIL_ENABLED=false` и `PAYMENTS_ENABLED=false` в `.env` —
уведомления и платежи выключены, всё остальное работает как обычно. Как
включить и проверить — см. `backend/README.md`.

Если backend не запущен, лендинг всё равно работает — формы просто
используют встроенный mock вместо реального сохранения (подробнее ниже).

## Что сейчас реально, а что mock

| Функция | Статус |
|---|---|
| `submitLead()` (формы партнёров + финальная форма) | **реальный backend** — `POST /leads` |
| `createBooking()` (модалка заказа осмотра) | **реальный backend** — `POST /bookings` |
| `checkVin()` (VIN-demo) | **реальный backend** — `POST /vin/check`, но результат всё ещё **demo** (детерминированный по строке VIN, не настоящая проверка истории авто) |

Все три функции при недоступном backend автоматически падают на
прежний client-side mock (см. `DEV_MOCK_FALLBACK` в `js/api/api.js`) —
сайт никогда не ломается из-за выключенного backend.

## Перед production

Полный пошаговый чек-лист (ADMIN_PASSWORD, APP_URL, SMTP, Stripe,
DEV_MOCK_FALLBACK, backup SQLite, CORS, HTTPS за прокси, smoke-тесты) —
в `backend/README.md`, раздел **«Production checklist»**. Коротко здесь:

- Хранилище уже не JSON, а SQLite (`backend/data/overeno.sqlite`) — для
  реальной многопроцессной нагрузки следующий шаг именно оттуда, это
  PostgreSQL (см. `backend/README.md` за подробностями и обоснованием).
- Выключить `DEV_MOCK_FALLBACK` в `js/api/api.js` (сейчас `true`) —
  иначе реально упавший backend в проде незаметно подменится моком.
- Задать собственный `ADMIN_PASSWORD` в `backend/.env` (не оставлять
  `change_me`).
- Задать `CORS_ORIGINS` в `backend/.env` (реальный домен фронтенда) —
  без этого API отвечает только localhost dev-портам, это безопасный
  fallback, а не рабочая конфигурация для реального домена.
- Публичный `POST /vin/check` остаётся подтверждённой demo-заглушкой
  (`result.isDemoResult: true`) сознательно — реальный (возможно платный)
  Vincario-провайдер теперь реализован и протестирован
  (`backend/vin/vincarioProvider.js`), но вызывается **только** админом
  вручную для уже оплаченного VIN check (`POST /admin/vin-checks/:id/run-provider`,
  `VIN_PROVIDER=real`+`VIN_PROVIDER_ENABLED=true`+ключи из Vincario
  dashboard) — и даже тогда отдаёт только технические характеристики
  (марка/модель/год/двигатель), не историю ДТП/пробега. Подробности,
  как включить и известные риски — `backend/README.md`, разделы
  «Real VIN provider adapter» и «GPT API readiness» (там же — как
  включить реальный OpenAI для AI-агентов, `AI_PROVIDER=openai`).
- Настроить реальный SMTP (или сменить `backend/email/emailClient.js` на
  Resend/SendGrid/Mailgun) и включить `EMAIL_ENABLED=true` — сейчас по
  умолчанию email выключен и работал только против тестового SMTP.
- Платежи — сейчас sandbox-фундамент (mock provider по умолчанию,
  Stripe-провайдер написан и доведён до test-mode-ready состояния: полные
  metadata в checkout session, отдельный статус `expired` — не путается
  с `cancelled`, идемпотентность на всех четырёх терминальных статусах).
  Пошаговая инструкция по Stripe test mode (ключи, webhook secret, test
  checkout, тестовые сценарии success/cancel/expired/failed) — раздел
  **«Stripe test mode setup»** в `backend/README.md`. Реальный Stripe
  test-аккаунт в этой среде не проверялся (нет сети до api.stripe.com) —
  код reviewed-but-unverified до первого реального прогона. Перед
  реальными деньгами: test mode → проверить весь путь → только потом
  live-ключи, плюс добавить idempotency/retry для вебхуков.
- Basic hardening уже есть (security headers, rate limiting на публичных
  POST-эндпоинтах, CORS через `CORS_ORIGINS` вместо хардкода) — но это
  не замена reverse proxy/WAF на реальном домене, только базовая защита
  в самом приложении. Полный production-readiness audit (все env-переменные
  реально используются, нигде нет секретов в коде, API-контракты не
  менялись) — пройден, детали в `backend/README.md`.
- Полная инструкция по деплою (env-чеклист, nginx/Caddy-примеры,
  backup/restore SQLite, smoke-checklist после деплоя) — раздел
  **«Production deployment»** в `backend/README.md`. Backend URL, который
  использует фронтенд, задаётся в **одном месте** — `js/config.js`
  (`window.OVERENO_CONFIG.apiBaseUrl`), подключён `<script>`-тегом на
  каждой странице перед её основным модулем. Локально ничего менять не
  нужно; для прода — отредактировать этот один файл (готовый шаблон —
  `js/config.example.js`). Если файл отсутствует — безопасный fallback
  на `http://localhost:3001`, ничего не ломается.
- `npm run backup:sqlite` (в `backend/`) — безопасный backup базы через
  SQLite online-backup API, не сырое копирование файла.

## Структура проекта

```
overeno-web/
├── index.html                     Пустой каркас: <div id="app"> + подключение styles.css и main.js
├── admin-leads.html                Admin-страница для просмотра/обработки лидов
├── admin-bookings.html             Admin-страница для просмотра/обработки objednávek prohlídek
├── admin-vin-checks.html           Admin-страница для VIN-проверок (read-only + PATCH .../note для внутренней заметки)
├── admin-email-logs.html           Admin-страница для email-логов (read-only + PATCH .../review для reviewed/resolved/заметки)
├── admin-payments.html             Admin-страница для платежей (read-only + PATCH .../note для внутренней заметки)
├── admin-agents.html               Admin-страница для агентов — полный CRUD (create/edit/deactivate), фильтры role/active
├── admin-reports.html              Admin-страница для report workflow + manual report builder (Summary/Sections/Preview/History)
├── admin-ai-runs.html              Admin-страница для AI orchestrator foundation — список/detail/approve-reject AI runs
├── report.html                     Публичная страница отчёта — report.html?token=..., без пароля (см. backend/README.md)
├── payment-success.html            Простая страница после (mock/Stripe) checkout
├── payment-cancel.html             Простая страница при отмене checkout
├── css/
│   ├── styles.css                 Все стили лендинга (перенесены из <style> без изменений)
│   ├── admin.css                  Стили для всех восьми admin-страниц (не трогает лендинг)
│   └── report.css                 Стили только для публичной report.html (переиспользует CSS-переменные styles.css)
├── js/
│   ├── config.js                  Runtime config — window.OVERENO_CONFIG.apiBaseUrl, единственное
│   │                               место для смены backend URL перед production (см. backend/README.md)
│   ├── config.example.js          Шаблон production-конфига (не подключается сам, просто образец)
│   ├── main.js                    Точка входа лендинга: монтирует все компоненты в #app, вызывает их init()
│   ├── i18n/
│   │   ├── translations.js        Все тексты CS/EN/RU/UK (183 ключа на язык, проверено — расхождений нет)
│   │   └── i18n.js                applyLang(), translate(), initLangSwitch()
│   ├── api/
│   │   └── api.js                 checkVin(), submitLead(), createBooking() — все три реально ходят
│   │                               в backend (POST /vin/check, /leads, /bookings) с fallback на mock,
│   │                               если backend не запущен. createPaymentCheckout() — без mock fallback
│   │                               (осознанно, см. FinalCTA.js). adminFetchLeads()/adminFetchVinChecks()/... —
│   │                               для admin-leads.html и admin-vin-checks.html. adminFetchAllAgentsForAssignment()/
│   │                               adminAssignLead()/adminAssignVinCheck() — для их дропдауна «Přiřazený agent».
│   ├── admin/
│   │   ├── admin-leads.js         Логика admin-leads.html (отдельно от main.js, не трогает лендинг;
│   │   │                           плюс назначение агента через тот же Save)
│   │   ├── admin-bookings.js      Логика admin-bookings.html (свои adminFetchBookings()/adminAssignBooking()
│   │   │                           и т.д., не переиспользует функции из api.js — полностью изолирован)
│   │   ├── admin-vin-checks.js    Логика admin-vin-checks.html (read-only + Save note pro internalNote
│   │   │                           + přiřazení agenta), использует adminFetchVinChecks()/... из api.js
│   │   ├── admin-email-logs.js    Логика admin-email-logs.html (read-only + Save review pro reviewed/
│   │   │                           resolved/internalNote, polně izolován — svoje adminFetchEmailLogs()/
│   │   │                           adminExportEmailLogsCsv()/adminUpdateEmailLogReview(), jako admin-bookings.js)
│   │   ├── admin-payments.js      Логика admin-payments.html (read-only + Save note pro internalNote
│   │   │                           + přiřazení agenta, polně izolován, tentýž vzor jako admin-bookings.js —
│   │   │                           poznámka se při otevření detailu vždy načte čerstvě ze serveru)
│   │   ├── admin-agents.js        Логика admin-agents.html — plný CRUD (create/list/filter/detail/edit/
│   │   │                           deactivate), polně izolován, tentýž fresh-GET-on-open vzor jako ostatní
│   │   ├── admin-reports.js       Логика admin-reports.html — status workflow (+historie), summary
│   │   │                           fields, internalNote, generate/copy/revoke public link,
│   │   │                           send-to-customer, polně izolován, fresh-GET-on-open
│   │   └── admin-ai-runs.js       Логика admin-ai-runs.html — list/filter/detail AI runs, approve/reject,
│   │                               čte ?entityType/?entityId z URL (odkaz z admin-reports.html)
│   ├── report-public.js           Логика report.html — GET /reports/public/:token, без пароля/сессии,
│   │                               nikdy nevolá žádný /admin/* endpoint
│   └── components/
│       ├── Header.js
│       ├── Hero.js
│       ├── ProblemSection.js
│       ├── HowItWorks.js
│       ├── VinDemo.js             api.checkVin() (реальный backend) + открывает BookingModal (передаёт VIN)
│       ├── Pricing.js
│       ├── Partners.js            Кнопки открывают PartnerFormModal (dealer/inspector формы)
│       ├── PartnerFormModal.js    Формы заявок автосалонов/техников → api.submitLead()
│       ├── Reviews.js
│       ├── FAQ.js
│       ├── FinalCTA.js            Использует api.submitLead() + маленькая тестовая кнопка
│       │                           оплаты (api.createPaymentCheckout()), явно помечена как test
│       ├── Footer.js
│       └── BookingModal.js        Город + термín + контакт (email/phone) → api.createBooking()
├── backend/                        Express-backend + SQLite + payments/ — см. backend/README.md
└── README.md
```

## Как каждый компонент устроен

Каждый файл в `js/components/` экспортирует:
- `html` — строка разметки этого блока (те же id/классы, что и в исходном файле);
- `init()` — вешает обработчики событий на элементы внутри своей разметки (если они есть).

`main.js` вставляет все `html` в `#app`, а затем вызывает все `init()` —
в этот момент разметка уже в DOM, так что `document.getElementById(...)`
внутри `init()` работает предсказуемо.

## Backend

`backend/` — Express-сервер: лиды (`POST /leads`), заявки на осмотр
(`POST /bookings`), VIN-проверки (`POST /vin/check`, demo-данные) и
sandbox-платежи (`POST /payments/checkout`, `POST /payments/webhook`),
плюс read-only admin-эндпоинты для всех четырёх. Хранилище —
**SQLite** (`backend/data/overeno.sqlite`). После сохранения записи
backend пытается отправить email-уведомления (`backend/email/`) —
выключено по умолчанию (`EMAIL_ENABLED=false`), никогда не блокирует
сохранение записи; то же самое для платежей (`PAYMENTS_ENABLED=false`
по умолчанию). Подробности — в `backend/README.md`.

## Статус подключения `js/api/api.js`

См. таблицу «Что сейчас реально, а что mock» в начале файла. Все три
функции (`submitLead`, `createBooking`, `checkVin`) уже подключены к
backend по одному и тому же паттерну — реальный запрос первым, тихий
fallback на mock только при недоступности backend.

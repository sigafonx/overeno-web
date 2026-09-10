# NEXIUM — Release Notes

## Version

`v1.0.0-launch-prep` — first production-launch-ready snapshot after 12
build stages (see list below). No git history is tracked in this
project; this document is the version marker. If/when this project
adopts git, tag this snapshot as `v1.0.0`.

Date: 2026-09-10.

## What's included

Twelve build stages, each shipped as a working, tested increment:

1. **Deployment foundation** — Express + SQLite backend, leads/
   bookings/VIN-check public endpoints, full admin CRUD, CSV exports,
   security headers, CORS allowlist, rate limiting, JSON→SQLite
   migration path.
2. **Frontend runtime config** — single `js/config.js` file controls
   which backend URL every page talks to; no rebuild step for a real
   deploy.
3. **Stripe test-mode payments** — provider-agnostic payment layer
   (`mock` and `stripe`), webhook handling with idempotency, entity
   auto-linking (booking/vin_check → payment → paid status).
4. **Report workflow** — full status machine
   (`created → in_review → draft_ready → report_ready → report_sent →
   completed`), auto-created after payment.
5. **Manual report builder** — section-based editor, default sections
   per report type, reorder/reset, admin-only preview, status-gated on
   required sections being filled.
6. **Secure report delivery** — crypto-random public token, generate/
   revoke/send-to-customer, public `report.html?token=...` page
   exposing only safe fields.
7. **AI orchestrator foundation** — agent registry, `ai_agent_runs`
   table, mock provider, mandatory human review workflow,
   `admin-ai-runs.html`.
8. **AI agents wave 1** (report-focused) — `listing_analysis`/
   `risk_scoring`/`report_writer`/`buyer_advisor`/
   `vin_risk_explanation`; structured JSON output; apply-to-report only
   after admin approval.
9. **AI agents wave 2** (business-focused) — `crm_follow_up`/
   `b2b_sales`/`support`/`operations_payment`; `agent_tasks` queue;
   never sends anything, never changes a payment status, never deletes
   data — only suggests.
10. **Real VIN provider adapter** — `demo`/`real`/`mock_real` behind
    one interface; public form always uses `demo`; real (possibly
    billed) calls only from an admin endpoint, paid-only by default.
11. **Inspector workflow** — admin-managed physical inspection process;
    inspectors/inspection jobs/text checklist; no technician login, no
    automatic payouts.
12. **Dealer workflow** — dealer profile → vehicles → verified badge,
    with a double admin gate (dealer must be verified, badge approval
    is always a separate explicit action); public `badge.html?code=...`
    page shows only safe fields.
13. **Production launch preparation** — full system audit, production
    risk matrix, expanded smoke checklist, launch mode config, rollback
    plan, this document.
14. **Real Vincario VIN provider + real OpenAI provider + 5 more AI
    agents** (this stage) — `backend/vin/vincarioProvider.js` (control-
    sum auth, `decode/info`+`decode`, tested against the real Vincario
    API); `backend/ai/aiClient.js`'s `openAiProvider` (official `openai`
    SDK, tested against the real OpenAI API); 5 new business agents
    (`lead_qualification`, `booking_coordinator_agent`,
    `admin_operations`, `revenue_share_agent`, `business_growth`) on top
    of the existing 9, for 14 total; `GET /admin/ai/health` +
    `GET /admin/ai/agents` (full catalog with allowed/forbidden actions,
    risk level, system prompt) surfaced on `admin-ai-runs.html`. No
    contract changes to any existing endpoint or page.

See `backend/README.md` for the full technical detail behind every one
of these — this document is a summary, not a replacement for it.

## Known limitations

Carried forward honestly from every stage, not resolved by this launch
prep pass (see `backend/README.md`'s "Известные ограничения" and the
new "Production risk matrix" section for the full picture):

- **SQLite, single file, single process.** No separate DB server. Fine
  for one backend process; a second process writing the same file
  concurrently is not supported.
- **Admin access is one shared password**, not per-user accounts,
  roles, or sessions. The `agents` table is business data (who's
  assigned what), not a login system.
- **`stripeProvider.js` is reviewed-but-unverified** — written
  carefully, but never run against a real Stripe account in this
  environment (no network access here). Test mode end-to-end before
  trusting it.
- **Vincario (real VIN provider) is wired up and tested**, but only
  returns technical vehicle specs (make/model/year/engine/…) — not
  accident/mileage/owner history, which is a separate paid Vincario
  product not called here. The example key pair this was tested with
  (`0e84bc0986a5`/`7f2d5614db`) was rejected by Vincario as an invalid
  control sum on three different real VINs — looks like a documentation
  example, not a working paid account; a real key from the Vincario
  dashboard is needed to see real vehicle data. The older, generic
  `realVinProviderAdapter.js` (Bearer token, unrelated to Vincario)
  remains an untested fallback for a different provider.
- **`AI_PROVIDER=openai` is implemented and tested** against the real
  OpenAI API (official `openai` SDK). `anthropic` (or any other name)
  is still just accepted without crashing, returning
  `PROVIDER_NOT_CONFIGURED`. `AI_MONTHLY_BUDGET_LIMIT` is a gate, not a
  spend meter — nothing in this codebase tracks cumulative real OpenAI
  cost; monitor actual usage in the OpenAI dashboard.
- **No technician/dealer login.** Both the inspector and dealer
  workflows are entirely admin-managed; neither role has an account.
- **No automatic payouts anywhere** — inspector and dealer workflows
  have zero financial fields; any real-world payment to a third party
  happens completely outside this system.
- **Email deliverability is unverified** — `emailService.js` has not
  been run against a real production SMTP provider.
- **No WAF/DDoS protection built in** — the in-memory rate limiter is a
  basic abuse safety net, not a substitute for a reverse proxy/CDN in
  front of the backend in production.

## Deployment steps

Full detail in `backend/README.md`'s "Production deployment" section;
summary:

1. `cd backend && cp .env.example .env` — fill in real values (see
   `backend/README.md`'s "Launch mode config" section for what must be
   real vs. what can stay demo).
2. `npm install --omit=dev`
3. Edit `js/config.js` (or generate it from `js/config.example.js`) to
   point at the real backend URL.
4. Set `DEV_MOCK_FALLBACK = false` in `js/api/api.js`.
5. `npm start` (keep alive via systemd/pm2/docker restart-policy — it
   does not daemonize itself).
6. Serve the frontend (everything except `backend/`) via any static
   host; put a reverse proxy (nginx/Caddy) in front of the backend for
   TLS termination.
7. Run through `backend/README.md`'s "Production checklist" and "Final
   smoke checklist" top to bottom.
8. Set up `npm run backup:sqlite` on a cron schedule.

## Rollback plan

Full detail in `backend/README.md`'s "Rollback plan" section. Summary:
rolling back the deployed zip is a stop-process → unzip-previous →
`npm install` → restart cycle (does not touch the database). Restoring
SQLite from a backup is stop-process → copy backup file over
`data/overeno.sqlite` → delete `-wal`/`-shm` → restart. Disabling
payments/AI/real-VIN-provider, or reverting to the mock payment
provider, is always a single `.env` value change + restart — no code
change, no data loss, in every case.

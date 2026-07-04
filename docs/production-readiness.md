# Relay NW Production Readiness

Last reviewed: April 2026

## Current Readiness

Relay NW is ready for a small, supervised paid beta with 1-3 friendly businesses.

It is not yet ready to sell broadly without hands-on onboarding and monitoring.

Update after hardening pass:
- SMS cooldown now includes `pending` messages.
- Production now refuses to boot if unsigned Twilio webhooks are enabled.
- Recording callbacks now log when no matching lead is found.
- Twilio phone numbers are normalized before cooldown and opt-out checks.
- The fresh Supabase schema now matches the current SMS status values.
- A customer setup checklist now exists at `docs/customer-setup.md`.
- The lead inbox now shows recent Twilio webhook events behind the password gate.
- A local webhook simulator now exists at `npm run simulate -- <scenario>`.
- The SMS send path now distinguishes "Twilio accepted the SMS but the lead update failed" from a true SMS send failure.

Update after error-handling hardening pass (June 2026):
- Stale leads from "Twilio accepted but lead update failed" now self-heal: the SMS status callback reconciles the lead via the messages table and logs the reconciliation in the webhook event log.
- Cooldown/opt-out check failures now fail closed: no SMS is sent, the lead is marked `failed` with the reason, and an admin alert is sent (never an ambiguous `pending`).
- A messages-table write failure after Twilio accepted no longer wrongly marks the lead `failed` (which would have re-opened the cooldown and risked a double text).
- Voicemail transcription runs that crash mid-flight no longer lock the lead in "processing" forever; stale runs (>10 min) are taken over, and failures converge to "Summary unavailable" in the inbox plus a webhook event log entry.
- Call-row bookkeeping failures no longer block the customer-facing SMS or 500 the Twilio webhook.
- New failure-injection simulator scenarios: `sms-status-failed`, `sms-status-orphan`, `recording-orphan`.
- New test suite: `tests/pipeline-failure-handling.test.mjs` (14 failure-injection tests covering the missed-call → SMS → lead pipeline).

Update after deep backend audit (June 2026):
- Concurrent missed calls from the same caller now resolve deterministically: exactly one lead sends the text (earlier lead wins, id tie-break). Previously both could mark `skipped_recent` and the caller would never be texted.
- Account resolution failures in Twilio webhook routes no longer 500 with no TwiML and no log; they downgrade to the unresolved-account path (200 TwiML + webhook event + admin alert).
- The `account_users` email lookup escapes ilike wildcards (tenant-isolation fix).
- `GET /api/sms-test/status` only returns messages involving the tenant's own phone numbers.
- New test suite: `tests/audit-fixes.test.mjs`.
- Deferred (documented, not changed): per-instance intake rate limiting; lead inbox pagination; per-account Twilio credentials (single Twilio account is assumed in recording playback and voicemail download).

Update after pre-customer confidence pass (June 2026):
- The recording webhook route now sets `maxDuration = 60` so automatic voicemail transcription is not killed by Vercel's default function timeout.
- Production boot now warns loudly if `RESEND_API_KEY`, `ADMIN_ALERT_EMAIL`, or `SENTRY_DSN` are missing (email alerts are the failure-visibility backstop when Supabase is unreachable).
- Webhook-event retention pruning is fire-and-forget — it no longer adds latency or failure risk to the webhook hot path.
- `supabase.sql` drops the redundant global unique indexes on `leads.call_sid` / `leads.twilio_message_sid` (idempotency is per-account; the account-scoped unique indexes remain) and adds a non-unique `leads_call_sid_idx`. Re-run `supabase.sql` to apply.
- Removed the dead `app/api/leads-login` stub (`leads-logout` remains as a live alias for `/api/auth/logout`).

Update after production-readiness audit (July 3, 2026 — audit only, no fixes; specs handed to implementation agent):
- Full audit of tenant isolation, SMS compliance live path, serverless concurrency/durability, silent-failure observability, and scale ceiling. Deliverables in `docs/impl-specs/` (executive verdict `00`, workstream specs `01`–`07`, residual-risk register `99`).
- Verified sound, with evidence: account scoping on every tenant helper and authed route (`assertAccountId` throughout `lib/supabase/*`; behavioral isolation tests); DB-constraint idempotency for leads/inbound_messages/messages (partial unique indexes + `23505` handling); deterministic concurrent-missed-call winner; fail-closed cooldown/opt-out on both automatic and manual send paths; Twilio signature validation on all five webhook routes with the production unsigned-override guard; unresolved-account webhooks make zero tenant writes; `envAccountConfig()` fallback is dead in production tenant paths (resolvers return unresolved; `assertTenantAccount` throws on null accountId); viewer read-only enforcement; magic-link-only auth with `shouldCreateUser: false` and escaped email lookup.
- Found (specs written, pinned by skipped tests in `tests/compliance-gaps.pinned.test.mjs`): no START/UNSTOP re-opt-in (opt_outs rows are permanent) + STOPALL unrecognized + no app-side HELP response (spec 01, before customer #1); A2P gating is display-only — `sms_enabled` can be enabled without an approved campaign (spec 02); dial-status/recording webhooks resolve only by CallSid, so a failed voice-webhook calls upsert means the caller is never texted (spec 03); voicemail transcription has a non-atomic processing claim and no automatic retry after instance death (spec 04); failed/skipped alert emails are themselves silent — no Sentry escalation (spec 05); intake rate limiting is per-instance memory (spec 06); recording playback would send Twilio credentials to whatever URL is stored on the lead row, and the RLS service-role-only posture is implicit with zero policies (spec 07).
- Scale ceiling stated: safe at 1-5 accounts / tens of missed calls per day each; first breaks are inbox pagination, then the sequential weekly-digest cron (~15-25 accounts), then the single-Twilio-account assumption.
- Could not verify in sandbox (manual checks listed in the executive verdict): `npm run build`, Twilio console default STOP handling, Supabase Auth signup settings, production env completeness (`CRON_SECRET`, `RESEND_API_KEY`, `ADMIN_ALERT_EMAIL`, `SENTRY_DSN`), and whether production has run the current `supabase.sql`.
- Test suite after audit: 70 pass, 7 pinned-skip, 0 fail.

Update after Spec 01 implementation (July 4, 2026):
- Implemented app-side inbound SMS lifecycle compliance for `docs/impl-specs/01-sms-opt-out-lifecycle.md`.
- `STOPALL` now records an opt-out alongside `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, and `QUIT`.
- `START`, `UNSTOP`, and `YES` now clear the account-scoped `opt_outs` row, allowing the app-level suppression state to reconverge with Twilio's carrier-level re-opt-in state.
- `HELP` and `INFO` now return app-side TwiML containing the account business name, message/data-rate language, variable frequency language, and STOP opt-out language; these messages are not forwarded to the owner.
- Owner-originated messages still short-circuit before keyword handling, preserving owner operational SMS behavior.
- New regression suite: `tests/sms-opt-lifecycle.test.mjs`.
- The three Spec 01 pinned tests in `tests/compliance-gaps.pinned.test.mjs` are now unskipped and passing.
- No schema changes; `supabase.sql` does not need to be re-run for this spec.

Update after Spec 02 implementation (July 4, 2026):
- Implemented A2P enablement gating for `docs/impl-specs/02-a2p-gating-enforcement.md`.
- The settings route now refuses to transition `sms_enabled` from off to on unless `account_settings.a2p_registration_status = 'approved'`.
- A2P status lookup failures fail closed as not approved and now log a visible server error.
- Turning SMS off remains allowed without consulting A2P status, and admin/viewer roles still cannot mutate `sms_enabled`.
- `scripts/provision-account.mjs` now refuses `SMS_ENABLED=true` unless it is setting `A2P_REGISTRATION_STATUS=approved` or reading an existing approved status for the account.
- New regression suite: `tests/a2p-gating.test.mjs`.
- The Spec 02 pinned test in `tests/compliance-gaps.pinned.test.mjs` is now unskipped and passing.
- No schema changes; `supabase.sql` does not need to be re-run for this spec.

Recommended launch posture:
- Personally onboard each business.
- Run one real end-to-end test per business.
- Watch the first week of calls, SMS events, and voicemail recordings.
- Keep A2P 10DLC and Twilio delivery status visible during setup.

## Scores

- Backend reliability: 82/100
- Twilio webhook correctness: 84/100
- Duplicate prevention/idempotency: 78/100
- Error handling: 80/100
- Observability/debuggability: 84/100
- Database/schema quality: 80/100
- Security/RLS/env safety: 80/100
- Maintainability for a non-expert developer: 82/100
- Paid beta readiness: 79/100

## Solid For V1

- Twilio signature validation exists on important webhook routes.
- Missed-call lead creation is idempotent per `CallSid`.
- SMS send failures are captured on the lead.
- SMS delivery callbacks update lead SMS status.
- Inbound SMS replies are deduped by `MessageSid`.
- Opt-outs are stored and checked before sending.
- Leads page shows failed or undelivered SMS states.
- Supabase uses service-role-only server writes with RLS enabled.
- Voicemail recordings attach to leads by `CallSid`.
- The lead inbox shows the most recent Twilio webhook events.
- Local webhook scenarios can be simulated without waiting on live calls.
- The code is now reasonably readable for a solo founder to maintain.

## Remaining Risks

- If Twilio accepts an SMS but the DB update fails, the lead now self-heals: the next Twilio status callback reconciles the lead through the messages table (backfilling the MessageSid) and records the reconciliation in the webhook event log. The only unrecoverable case is both the lead update and the message-row insert failing in the same request, which triggers an admin alert with the MessageSid.
- Forwarding mode depends on carrier caller-ID behavior.
- Deep debugging can still require Twilio logs, especially for carrier/A2P delivery problems.

## Must Fix Before First Paying Customer

1. Run the latest `supabase.sql` in Supabase.
2. Confirm `ALLOW_UNSIGNED_TWILIO_WEBHOOKS` is false in production. The app now also blocks this at runtime.
3. Include `pending` in the recent-SMS cooldown check. Done.
4. Add a production guard that blocks unsigned Twilio webhooks in production. Done.
5. Create a customer setup checklist for call forwarding, Twilio number settings, A2P, and test calls. Done in `docs/customer-setup.md`.
6. Complete one real test per business: missed call, voicemail, lead, SMS status, inbound reply, opt-out.

## Should Fix During Beta

1. Detect and log zero-row recording updates. Done.
2. Add a simple webhook simulator script. Done.
3. Show recent webhook/SMS events in the lead drawer or owner admin view. Done on the lead inbox page.
4. Normalize Twilio phone numbers before DB writes/checks. Done for missed-call and inbound-SMS paths.
5. Improve partial-failure handling after Twilio accepts an SMS but DB update fails. Partially done: the webhook event now records `sent_update_failed`.

## Can Defer

- Business-hours logic.
- Analytics dashboards.
- Revenue recovered.
- Multi-tenant portals.
- Automated onboarding.
- User accounts.

## Ranked Punch List

### 1. Include `pending` in SMS cooldown

Severity: High

Why it matters: Prevents rapid repeat calls from receiving multiple texts before the first SMS status changes to `sent` or `delivered`.

Files:
- `lib/supabase.ts`
- `lib/missed-call.ts`

Difficulty: Small

Required before beta: Yes

Status: Done.

### 2. Add production guard for unsigned webhooks

Severity: High

Why it matters: Prevents accidental public abuse if `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=true` is left on.

Files:
- `lib/env.ts`

Difficulty: Small

Required before beta: Yes

Status: Done.

### 3. Run latest Supabase SQL

Severity: High

Why it matters: SMS delivery tracking and inbound SMS dedupe depend on new columns and tables.

Files:
- `supabase.sql`

Difficulty: Small

Required before beta: Yes

Status: Still requires running `supabase.sql` in the customer's Supabase project.

### 4. Detect zero-row recording updates

Severity: Medium

Why it matters: Avoids silent voicemail attachment failures.

Files:
- `lib/supabase.ts`
- `app/api/twilio/recording/route.ts`

Difficulty: Small

Required before beta: No, but soon

Status: Done.

### 5. Add webhook simulator

Severity: Medium

Why it matters: Makes debugging possible without making real calls every time.

Files:
- `scripts/simulate.ts`
- `package.json`

Difficulty: Medium

Required before beta: No

Status: Done.

### 6. Show recent webhook/SMS events in app

Severity: Medium

Why it matters: Helps answer "what happened?" without opening Supabase or Twilio.

Files:
- `app/leads/leads-list.tsx`
- `lib/supabase.ts`

Difficulty: Medium

Required before beta: No

Status: Done.

### 7. Normalize Twilio phone numbers

Severity: Medium

Why it matters: Prevents cooldown or opt-out mismatch edge cases.

Files:
- `lib/missed-call.ts`
- `app/api/twilio/sms/route.ts`

Difficulty: Small

Required before beta: No

Status: Done for missed-call and inbound-SMS paths.

### 8. Improve SMS accepted / DB update failure handling

Severity: Medium

Why it matters: Avoids cases where Twilio sent a text but the lead does not show the message SID or updated status.

Files:
- `lib/missed-call.ts`

Difficulty: Medium

Required before beta: No, but valuable

Status: Done. The SMS status callback now reconciles stale leads via the messages table (matching the MessageSid to the lead, backfilling `twilio_message_sid`, and converging `sms_status` to Twilio's true delivery status). Reconciliations are recorded in the webhook event log. Covered by `tests/pipeline-failure-handling.test.mjs` and the `sms-status-orphan` simulator scenario.

### 9. Align initial schema check constraint

Severity: Low

Why it matters: Removes schema confusion for fresh database setup.

Files:
- `supabase.sql`

Difficulty: Tiny

Required before beta: No

Status: Done.

### 10. Add customer setup checklist

Severity: Low

Why it matters: Reduces onboarding mistakes with call forwarding and Twilio settings.

Files:
- `README.md`
- or `docs/customer-setup.md`

Difficulty: Small

Required before beta: Operationally, yes

Status: Done in `docs/customer-setup.md`.

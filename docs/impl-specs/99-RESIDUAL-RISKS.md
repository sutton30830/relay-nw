# Residual Risks — deliberately deferred, July 3, 2026

Everything here is real, verified, and consciously not in a spec. Each entry has a trigger condition; when the trigger fires, promote it to a spec.

## R1 — No inbox pagination (Severity: Medium)

`getLeadsForAccount` (`lib/supabase/leads.ts:251-296`) loads every non-paginated lead for the account and attaches messages with capped sub-queries (200/500 rows). **Becomes urgent when:** any single account passes ~300 leads or the inbox noticeably slows. **Timing:** first busy pilot month; pair with the outcome-view contract in `docs/inbox-ux-cleanup-2026-07.md`.

## R2 — Weekly digest cron has no maxDuration and loops accounts sequentially (Severity: Medium)

`app/api/digest/weekly/route.ts` runs ~5 queries + 1 email per account in one invocation with the default function timeout. Partial completion is recorded in the response nobody reads; accounts late in the list silently get no digest. **Becomes urgent when:** ~10-15 active accounts. **Timing:** add `export const maxDuration = 300;` opportunistically (one line, zero risk — an implementer may include it in any spec's PR); batch/fan-out redesign only past ~50 accounts.

## R3 — Single Twilio account assumption (Severity: Medium, dormant)

`resolveAccountByCallSid`/`ByMessageSid` look up SIDs globally (correct while all numbers share one Twilio account); recording playback and voicemail download use the single env credential (`app/api/recordings/[recordingSid]/route.ts:38`, `lib/voicemail-ai.ts:39`); `twilioClient` is a singleton on env creds. Already documented as deferred in the June audit. **Becomes urgent when:** a second Twilio account or ISV subaccounts are introduced (e.g., per-customer A2P brands). Then: add `twilio_account_sid` to `accounts`, scope SID resolvers by it, and build per-account clients. **Timing:** before subaccount migration, not before.

## R4 — Same email in two tenants breaks login (Severity: Low)

`findAccountUser` (`lib/auth.ts:74-78`) uses `.maybeSingle()` on an email lookup; two `account_users` rows with the same email in different accounts make it error, so that user can't log in at all (fail-closed, not a leak). **Becomes urgent when:** onboarding a multi-location owner or a bookkeeper shared across two pilot businesses. **Timing:** with self-serve auth work; until then provision distinct emails.

## R5 — Owner cannot opt out of operational texts (Severity: Low)

The owner-message early return (`app/api/twilio/sms/route.ts:131`) means an owner texting STOP to their own Relay number is ignored app-side — but Twilio still records the carrier-level opt-out, after which `sendOwnerSms` fails on every send (caught + logged, email fallback still works). Slightly confusing, not dangerous. **Becomes urgent when:** an owner actually does this and asks why texts stopped. **Timing:** note added to `docs/pilot-onboarding.md` is sufficient for pilots.

## R6 — Owner notification silently skipped when no recipient (Severity: Low)

`sendEmail` logs `Email notification skipped` at info level when an account has no `owner_email` (`lib/email.ts:82-89`); leads still flow, but the owner may believe they'd be emailed. Mitigated by `scripts/verify-account.mjs` (checks `owner_email is set`) and by spec 05's Sentry escalation for the admin tag. **Becomes urgent when:** onboarding stops using `verify:account`. **Timing:** keep the script mandatory in the checklist.

## R7 — Webhook event payloads keep sanitized metadata only; deep debugging still needs Twilio logs (Severity: Low, accepted)

`sanitizedWebhookPayload` (`lib/supabase/webhooks.ts:27-49`) deliberately stores last-4s and SIDs, not bodies. This is a privacy feature; the cost (already noted in the ledger) is that carrier/A2P delivery forensics require the Twilio console. No action planned.

## R8 — `getLeadsForAccount` legacy-column fallback paths (Severity: Low)

The missing-column fallbacks (`lib/supabase/leads.ts:14-26, 267-290` and siblings) exist to survive deploy-before-migration windows. They are tenant-safe (all still scoped by `account_id`) but they mask schema drift as warnings. **Becomes urgent when:** the production DB has verifiably run the current `supabase.sql` (executive-verdict manual check 6) — then delete the fallbacks in a cleanup pass so schema drift fails loudly instead.

## R9 — Alert volume concentration (Severity: Low)

All operational alerts go to one `ADMIN_ALERT_EMAIL` with no dedup/throttle; a flapping webhook could send hundreds of emails in an hour (each unresolved webhook = one email, `lib/twilio/unresolved-account.ts:50-55`). Survivable at pilot scale; Resend quota is the real ceiling and spec 06's global intake cap protects the biggest abuse vector. **Becomes urgent when:** the first alert storm happens or accounts pass ~10. **Timing:** add a per-issue-type hourly cap when it first hurts; a weekly "alerts sent/failed" line in the digest is a nice companion to spec 05.

## R10 — Sandbox-unverifiable items (tracked, not risks per se)

`npm run build`, real Twilio console opt-out configuration, Supabase Auth signup settings, production env completeness — all enumerated as manual checks in `00-EXECUTIVE-VERDICT.md`. They stay open until the operator confirms each one.

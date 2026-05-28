# Relay NW — Pilot Readiness Audit

> Historical audit snapshot. Several findings in this document have since been completed; use current tests, production smoke checks, and git history as the source of truth.

**Scope:** Readiness to onboard 1–3 white-glove pilot customers. Focus: bugs, security, tenant isolation, operational risk, missing tests. Audited working tree at `relay-nw copy` (branch `main`, with uncommitted changes to `app/ops/page.tsx`, `lib/email.ts`, and untracked `app/api/email-test/`, `tests/account-isolation.test.mjs`).

**Verified during audit:** `npm test` → 13 passed. `npm run typecheck` → clean. No secrets in tracked files; `.env*` is gitignored.

---

## Verdict

**SHIP customer #1** as a white-glove, email-first pilot (SMS only after that customer's own A2P is approved), after a short pre-flight checklist and one small fix (intake leads). **No hard security blocker was found** — the authenticated surface is consistently account-scoped and Twilio webhooks are signature-validated.

**The single most important thing to fix before customer #2:** make the "account couldn't be resolved" path fail *loudly* instead of silently falling back to the env/default account. Today a provisioning mistake (a customer's Twilio number not registered) produces invisible, orphaned data instead of an error.

---

## High-priority findings

### H1 — Intake/"setup request" leads are written with `account_id = NULL` and never surface anywhere
**Files:** `app/api/intake/route.ts:181`, `lib/supabase/leads.ts:103` (`createLead`), `lib/supabase/leads.ts:158` (`getLeadsForAccount`)

`createLead()` is called with no `accountId`, so every website "Relay NW setup request" is stored with `account_id = NULL`. The dashboard query filters `.eq("account_id", accountId)`, so **null-account leads are invisible in every `/leads` view**, and there is no owner/admin email on intake. Net effect: inbound *sales* leads for Relay NW itself can come in and you never see them — the exact "missed revenue" failure the product exists to prevent.

**Fix (small):** resolve the default account (`getDefaultAccountConfig()`), pass its `accountId` into `createLead`, and/or send an admin email on each intake submission. Low effort, directly protects your own funnel.

### H2 — Silent env/default fallback when an account can't be resolved
**Files:** `lib/supabase/accounts.ts:168` `resolveAccountByTwilioNumber`, `:193` `resolveAccountByCallSid`, `:217` `resolveAccountByMessageSid` (all return `envAccountConfig()` with `accountId: null` on miss)

Every Twilio webhook resolves the tenant by the called number / CallSid / MessageSid. On a miss, it falls back to `envAccountConfig()`, which has `accountId: null` and Relay NW's own env values. In that null-account state:

- Missed-call **leads are written with `account_id = NULL`** (invisible, same as H1).
- `upsertCall` / `createMessageIfNew` **silently no-op** (those tables require non-null `account_id`), so the call/message rows are simply lost.
- `findPendingForwardingHealthCheck(null)` searches **across all accounts** (no account filter) — an inbound call to an unregistered number could mark a *different* tenant's pending health check as "passed." This is a genuine cross-account write, though it requires a coincident pending check.

This is not an active leak today (with one pilot it can't trigger), but it turns a **provisioning mistake into silent data loss / cross-tenant noise** the moment you add customer #2 and forget to register their number in `account_phone_numbers`.

**Fix before customer #2:** in production, treat an unresolved webhook as a loud failure — log + `notifyAdminOperationalIssue` + stop, rather than processing under the env default. At minimum, alert when a webhook resolves to a null account.

---

## Medium-priority findings

### M1 — Tenant isolation rests entirely on app-code filters; RLS is inert for the live path
**Files:** `supabase.sql:327-328` (comment: service-role only, no policies), `lib/supabase/client.ts:4` (only the service-role client exists)

RLS is *enabled* on every table but **no policies are defined**, and all data access uses the service-role key, which **bypasses RLS**. So RLS is real defense-in-depth against the anon key (deny-all), but it provides **zero protection for the actual application path**. Isolation is 100% "every query remembers to filter `account_id`."

The audited code does this correctly everywhere on the authenticated surface (`/leads`, `/ops`, `PATCH/DELETE /api/leads/[id]`, recording playback, transcription all thread `auth.session.accountId`). The latent hazard is the helper pattern `.match(accountId ? { account_id: accountId } : {})` (e.g. `lib/supabase/leads.ts:296,329`, `lib/supabase/voicemails.ts:13,31,49,100`): if a caller ever omits `accountId`, the query **silently runs across all tenants** by UUID alone. No live caller does this, but it's one refactor away from a leak.

**Cheap, high-leverage fix:** make those helpers **fail closed** — throw if `accountId` is missing on a tenant-scoped read/write — so a future mistake becomes a loud error instead of a quiet cross-account query. Acceptable to keep service-role-only architecture for pilots; full RLS policies + an anon-key client are only needed if you ever read tenant data from the browser.

### M2 — The "isolation" tests assert on source text, not behavior
**File:** `tests/account-isolation.test.mjs`

These tests `readFile` the route/lib sources and regex-match for strings like `.eq("account_id", accountId)`. That confirms the *pattern is present* but never runs two accounts against a database, so it cannot catch a resolver returning the wrong account, the `.match({})` fallback, or the H1 null-account bug. Useful as a cheap guardrail; don't mistake it for proof of isolation.

**Before customer #2:** add one behavioral test that inserts data for account A and asserts account B's session cannot read or mutate it (against a local/test Supabase).

### M3 — No Supabase session refresh (no `middleware.ts`)
**Files:** `lib/auth.ts:33-41` (`setAll` swallows the "can't set cookies in a Server Component" case); no middleware present

Magic-link sessions are read fresh each request, but there's no middleware to refresh the auth cookie, and Server Component pages can't write it. In practice owners will likely be bounced to `/login` when the JWT expires (~1h default). Annoyance, not a security issue — fine for white-glove pilots, worth adding later.

---

## Low / acceptable (no action required to ship)

- **`/api/email-test/start` is safe to keep.** It is `requireAccountUserJson()`-gated and only emails the caller's *own* account owner address (`app/api/email-test/start/route.ts:7-13`). Same for `/api/sms-test/*` and `/api/health-check/*` — all auth + account scoped. Optional polish: gate to `owner`/`admin` role and hide the ops button post-launch; not a blocker, not a leak.
- **Twilio webhook security is strong (Q3).** All five webhooks validate `x-twilio-signature` against candidate URLs (handles Vercel proxy host/proto), reject on failure, and the `ALLOW_UNSIGNED_TWILIO_WEBHOOKS` override is hard-blocked in production by `lib/env.ts:70-72`. Payloads are sanitized before logging (last-4 only, no raw SMS body — `lib/supabase/webhooks.ts:25-47`). Idempotency is enforced by account-scoped unique indexes (`unique (account_id, call_sid)`, `unique (account_id, twilio_message_sid)`).
- **Email + voicemail flows are production-safe (Q4).** Resend client is lazily created and skips gracefully without a key/recipient (`lib/email.ts:7-17,82-89`). Owner address resolves `account_settings.owner_email` → `account_users` fallback. Transcription is account-scoped, runs in background via `after()`, guards against double-processing, and alerts admin on failure (`lib/voicemail-ai.ts`).
- **Intake rate-limiting is in-memory** (`app/api/intake/route.ts:10`) so it's best-effort per serverless instance on Vercel; the honeypot is the real defense. Fine for now.

---

## Answers to your specific questions

1. **Is isolation strong enough for manually provisioned pilots?** Yes. The authenticated surface is consistently scoped to `session.accountId`, login requires an `account_users` membership (`shouldCreateUser: false`), and writes to the strict tables fail safe when no account is present. The weaknesses are *silent fallbacks*, not active leaks.
2. **Any routes/queries that could leak cross-account data?** No active cross-tenant read was found. Latent risks: the `.match({})` empty-filter fallback (M1), the null-account webhook fallback (H2, incl. the health-check cross-account write), and orphaned intake leads (H1). All are "fail-open" patterns to convert to "fail-closed."
3. **Is Twilio account-resolution safe/reliable?** Safe and reliable **for registered numbers**, with solid signature validation. Make the unregistered-number path fail loudly before customer #2.
4. **Owner email + voicemail/SMS production-safe?** Yes.
5. **Keep `/api/email-test/start`?** Keep it — it's auth- and account-scoped and only mails the caller's own owner address. Optionally role-gate and hide the button after launch. Not admin-only-required, not a removal candidate.
6. **Shortest path to customer #1:** see checklist below.
7. **Before customer #2:** fail-closed on missing `accountId` (M1), loud unresolved-webhook handling (H2), one behavioral cross-tenant test (M2), and make `leads.account_id` NOT NULL after backfill.
8. **Defer:** full self-serve onboarding, RLS policies + anon-key client migration, session-refresh middleware, custom advanced opt-out, and any new lead/inbox features. None change pilot ROI.

---

## Next-step checklist

### Before customer #1 (do these)
- [ ] Apply `supabase.sql` to the production database.
- [ ] Confirm the `relay-nw` account row exists and `account_phone_numbers` has **+14253689655** as `is_primary` (verify the old `+1YOUR_TWILIO_NUMBER` placeholder is gone in prod, not just locally).
- [ ] Verify prod env: `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=false`, correct `APP_BASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` set, `RESEND_API_KEY` + `ALERT_FROM_EMAIL` (`Relay NW <alerts@relay-nw.com>`) + `ADMIN_ALERT_EMAIL` set, `SMS_ENABLED=false` until the pilot's A2P is ready.
- [ ] **Fix H1** (intake leads → real account + admin email). ~30 min; protects your own sales funnel.
- [ ] Provision the pilot with `npm run provision:account`, create the owner in Supabase Auth, and confirm the `account_users` row.
- [ ] Point the pilot's Twilio number at `/api/twilio/voice` and `/api/twilio/sms` (POST) and register that number in `account_phone_numbers`.
- [ ] Run the acceptance test in `docs/pilot-onboarding.md` §5 end-to-end.

### Before customer #2 (cheap hardening)
- [ ] **H2:** unresolved webhook → log + admin alert + stop (no silent env fallback in prod).
- [ ] **M1:** make tenant-scoped DB helpers throw when `accountId` is missing (fail closed).
- [ ] **M2:** add one behavioral cross-tenant isolation test.
- [ ] Backfill and set `leads.account_id` (and the other nullable tenant tables) to `NOT NULL`.

### Defer (don't spend money/time yet)
- [ ] Self-serve onboarding, RLS policies + anon-key client, session-refresh middleware, advanced opt-out customization, new inbox features.

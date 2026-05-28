# Multi-Tenant Hardening Plan

> Historical planning snapshot. Several findings and workstreams in this document have since been completed; use current tests, migrations, and git history as the source of truth.

**Goal:** Make the Relay NW core genuinely multi-account-safe and *provable* before customer #1 — so adding account #2, #3, #4 is a trusted config step. **Out of scope (deferred until a pilot is paying):** self-serve signup, automated Twilio number purchasing, billing, admin UI.

**Guiding property:** every tenant-scoped read/write must *fail closed* — if an `account_id` is missing or a webhook can't be attributed, the system raises a loud error and refuses to touch tenant data, rather than silently operating across all accounts or writing orphan rows.

**Definition of done:**
- No code path can read or write tenant data without an explicit `account_id`.
- The database makes orphaned (null-account) rows impossible.
- An automated two-account test proves account B cannot see or mutate account A's data.
- A repeatable multi-account simulation you can run on demand.
- `npm test` + `npm run typecheck` green after every step.

---

## Workstream 1 — Fail-closed tenant scoping
**Why:** Today helpers use `.match(accountId ? { account_id } : {})`; if a caller ever omits `accountId`, the query silently spans all tenants. (Audit M1.)

- Add `assertAccountId(value): string` (new `lib/supabase/tenant.ts`) that throws on null/empty.
- Change every tenant-scoped function signature from `accountId?: string | null` to required `accountId: string`, call `assertAccountId` first, and replace the `.match({})` fallback with a plain `.eq("account_id", accountId)`.
  - Files: `lib/supabase/leads.ts`, `lib/supabase/voicemails.ts`, `lib/supabase/messages.ts`, `lib/supabase/calls.ts`, `lib/supabase/webhooks.ts`, `lib/supabase/health-checks.ts`.
- Delete the unused null-variants `getLeads()` and `getRecentWebhookEvents()` (grep confirms no callers) so the footgun can't be reintroduced.
- Opt-out stays per-account (`isOptedOut`/`recordOptOut` require `accountId`) — correct A2P behavior.

**Proven by:** typecheck (signature changes ripple to all call sites) + a lint-style test asserting no `.match(` empty-fallback remains.

## Workstream 2 — Loud, safe webhook account resolution
**Why:** Resolvers silently fall back to the env/default account with `account_id = null` on a miss, causing invisible leads, no-op call/message writes, and a cross-account health-check write. (Audit H2.)

- Change `resolveAccountByTwilioNumber` / `resolveAccountByCallSid` / `resolveAccountByMessageSid` to return a discriminated result: `{ status: "resolved", account }` or `{ status: "unresolved" }` — no more null-id env config in production.
- In each webhook route, on `unresolved` **in production**: skip all tenant writes, log a clearly-flagged `webhook_event`, fire `notifyAdminOperationalIssue` ("call/SMS to unregistered number +1…"), and still return valid TwiML / 200 so the caller experience and Twilio retries behave. (A real customer number is always registered, so unresolved = a misconfiguration you want to hear about immediately.)
- Keep the env-config path for **local/dev only** (so `scripts/simulate.mjs` still works), gated on `NODE_ENV !== "production"`.

**Proven by:** a test that drives each webhook with an unregistered number and asserts (a) no lead/call row is written, (b) an admin alert fires, (c) the response is still valid TwiML.

## Workstream 3 — Database constraints: orphan rows become impossible
**Why:** `leads`, `webhook_events`, `opt_outs`, `inbound_messages`, `forwarding_health_checks` allow `account_id = NULL`. The DB should enforce what the code now guarantees. Pre-customer is the safest possible time to do this.

- One-time backfill (new `scripts/backfill-account-ids.mjs`): assign existing null-account rows to the `relay-nw` house account, or delete obvious test rows. Dry-run first, print counts.
- After backfill, add `NOT NULL` to `account_id` on those five tables in `supabase.sql` (idempotent `alter ... set not null`), plus a short runbook for applying it to prod in the correct order (code first → backfill → constraint).

**Proven by:** the backfill script's before/after counts; `supabase.sql` re-applies cleanly; insert of a null-account row is rejected by Postgres.

## Workstream 4 — Fix intake leads (H1)
**Why:** Website "setup request" leads are written with `account_id = null` and never appear in any dashboard, with no notification — you silently lose your own sales leads.

- `app/api/intake/route.ts`: resolve the `relay-nw` house account and pass its `accountId` to `createLead`, so setup requests land in your own `/leads`.
- Send an admin notification (`notifyAdminOperationalIssue` or a dedicated "new setup request" email) on each submission.

**Proven by:** a test that posts a valid intake form and asserts the lead is created with the house account id and an admin email is attempted.

## Workstream 5 — Make it provable: real multi-account tests + simulation
**Why:** Current `tests/account-isolation.test.mjs` only greps source text; it can't catch logic bugs. (Audit M2.)

- Add a small test seam to `lib/supabase/client.ts` (allow injecting a Supabase double for tests; production unchanged).
- Behavioral isolation tests with an in-memory Supabase double + two accounts (A, B): assert B's session cannot read A's leads, cannot update/delete A's lead by id, cannot play A's recording, cannot transcribe A's voicemail; assert webhooks attribute rows to the correct account.
- Extend `scripts/simulate.mjs` into a **two-account end-to-end simulation** (provision A and B, fire missed-call/recording/SMS webhooks for each, assert each account sees only its own data). This is the artifact you run to *feel* it scales.
- Keep the source-text test as a fast regression guard.

**Proven by:** new tests pass and genuinely fail if an `account_id` filter is removed (I'll demonstrate by temporarily breaking one).

## Workstream 6 — Provisioning confidence (light)
**Why:** The remaining H2 footgun is forgetting to register a new number. Reduce it without building UI.

- Add `npm run verify:account -- <slug>`: checks the account row exists, a primary number is registered in `account_phone_numbers`, and an owner exists in `account_users` (with a reminder to create the matching Supabase Auth user). Prints a green/red checklist.

**Proven by:** running it against `relay-nw` and a freshly provisioned test account.

---

## Sequencing
1. **WS1** fail-closed signatures → 2. **WS2** webhook resolution → 3. **WS4** intake fix (stop all new null writes) → 4. **WS3** backfill + NOT NULL (lock it at the DB) → 5. **WS5** behavioral tests + simulation (prove it) → 6. **WS6** verify script.

`npm test` + `npm run typecheck` after each. I'll show diffs per workstream.

## Risks / things I'll be careful about
- **NOT NULL migration touches data** — done only after code stops writing nulls and after a dry-run backfill; safest now while the DB is essentially empty.
- **Webhook resilience** — fail-closed must never turn a Twilio webhook into a 500; routes still return valid TwiML and alert instead.
- **Test seam** — a minimal, production-neutral refactor of `client.ts`; no behavior change in prod.

## Rough effort
~1–2 focused working sessions total. WS1–WS4 are the bulk; WS5 is the highest-value "provable" piece.

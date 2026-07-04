# Executive Verdict — July 3, 2026

## Is Relay NW safe for a supervised first paying pilot today?

**Yes, with two conditions.** Tenant isolation is sound and provable: every tenant-scoped Supabase helper asserts and filters by `account_id`, every webhook either attributes work to a resolved account or refuses tenant writes loudly, idempotency is enforced by real DB unique constraints, and the auth path (magic-link only, `shouldCreateUser: false`, escaped email lookup) has no open signup hole. The missed-call → text → reply money path fails loudly, not silently, in every branch I walked.

The two conditions before taking the first customer's money:

1. **Ship spec 01 (SMS opt-out lifecycle).** Today a caller who texts STOP and later texts START stays suppressed forever at the app level, STOPALL is not recognized, and HELP gets no app-side response. For a product whose entire pitch is compliant customer-care texting, this is the one gap that touches the carrier rules you were approved under. It is a small fix (1–2 days).
2. **Run the manual checks below.** Several safety claims depend on production configuration this audit could not see.

Everything else can ship on the schedule below.

## Must ship before customer #1

- **Spec 01 — SMS opt-out lifecycle** (START/STOPALL/HELP). Compliance-touching; small.
- **Manual checks** (operator, ~30 minutes, see bottom of this page).

## Must ship before account #5

- **Spec 02 — A2P gating enforcement.** Today `sms_enabled` can be switched on for an account whose A2P registration is not approved; nothing in code stops it. With 1 account you are the only person who can make that mistake; with 5 you will eventually make it.
- **Spec 03 — dial-status resolution fallback.** If the voice webhook's call-row write fails, the follow-up dial-status webhook can't find the account and the caller is never texted (you get an alert email, the customer gets silence). One transient Supabase blip on the wrong request kills the product's core promise for that call.
- **Spec 04 — transcription durability.** Voicemail summarization rides `after()` with no automatic retry and a non-atomic processing claim. A killed instance means "Generating summary…" until someone clicks retry; a concurrent trigger means double OpenAI spend and duplicate URGENT owner texts.
- **Spec 05 — alerting backstop.** Admin email alerts are the failure-visibility backstop, but a failed alert send is itself silent (console only). Wire alert failures into Sentry, which is already installed.

## Must ship before account #25

- **Spec 06 — durable intake rate limiting** (per-instance Map today; abuse cost, not correctness).
- **Spec 07 — defense-in-depth hardening** (recording-URL host allowlist, documented RLS posture).
- Inbox pagination and digest-cron `maxDuration` (tracked in 99-RESIDUAL-RISKS; the inbox and weekly digest are the first things that degrade with volume).

## Scale ceiling, stated plainly

Safe today: **1–5 accounts at tens of missed calls per day each.** What breaks, in order: (1) the lead inbox — `getLeadsForAccount` loads every lead with no pagination, so a busy account's inbox slows first (hundreds of leads); (2) the weekly digest cron — it loops accounts sequentially in one function invocation with no `maxDuration`, so somewhere around 15–25 accounts it will start timing out partway through the loop; (3) the single-Twilio-account assumption — `resolveAccountByCallSid`/`ByMessageSid` look up SIDs globally and recording playback/download use the single env Twilio credential, so adding a second Twilio account requires the deferred per-account-credentials work first. Webhook hot paths themselves (a handful of indexed Supabase queries each) are nowhere near any limit at this scale.

## Verified sound (no spec needed)

- Tenant scoping of every helper in `lib/supabase/*` and every authed API route (evidence: `assertAccountId` on all 30+ tenant helpers; behavioral tests in `tests/account-isolation.test.mjs`, `tests/behavioral-isolation.test.mjs`).
- DB-level idempotency: `leads_account_call_sid_unique_idx`, `inbound_messages.message_sid` unique, `messages (account_id, twilio_message_sid)` unique; concurrent duplicate webhooks converge via `23505` handling (`lib/supabase/leads.ts:236-241`).
- Concurrent same-caller missed calls: deterministic winner (`lib/supabase/messages.ts:130-143`, covered by `tests/audit-fixes.test.mjs`).
- Fail-closed pre-send compliance checks on both the automatic path (`lib/missed-call.ts:164-215`) and manual replies (`app/api/leads/[id]/reply/route.ts:82-104`).
- Webhook signature validation on all five Twilio routes with production guard against the unsigned override (`lib/env.ts:67-75`).
- Unresolved-account webhooks: 200 TwiML, sanitized event log, admin alert, zero tenant writes (`lib/twilio/unresolved-account.ts`).
- `envAccountConfig()` legacy fallback is dead in production tenant paths: all resolvers return `unresolved` in production rather than falling back, and `handleMissedCall` throws on a null accountId (`lib/supabase/tenant.ts:5-15`).
- Viewer read-only enforcement (`requireWriteAccessJson`, covered by `tests/role-enforcement.test.mjs`).

## Explicitly unverified — manual checks the operator must run

This audit ran in a sandbox with no production access. Before customer #1, verify each of these by hand:

1. **Twilio default STOP handling:** in the Twilio console for the pilot number, confirm US messaging opt-out handling is active (send STOP from a test phone; you should get Twilio's confirmation text and subsequent sends should fail with error 21610). Spec 01 depends on Twilio handling the STOP confirmation itself.
2. **Supabase Auth signups:** in Supabase dashboard → Authentication → Providers, confirm public email signups are disabled (the app never creates users, but the Supabase project settings are outside the repo).
3. **Production env:** confirm `CRON_SECRET`, `RESEND_API_KEY`, `ADMIN_ALERT_EMAIL`, and `SENTRY_DSN` are all set in Vercel production env. The code only warns at boot.
4. **`npm run build`:** could not be run in the sandbox (network/Sentry). Run a normal Vercel preview deploy to confirm.
5. **`npm run typecheck`:** passes on source files; the sandbox showed only TS6053 noise from a missing `.next/types` directory (stale include). Run once locally after a `next build` to confirm a clean pass.
6. **Latest `supabase.sql` applied:** the ledger's standing item — re-run it in the production Supabase project so the dropped global unique indexes and current constraints match the repo.

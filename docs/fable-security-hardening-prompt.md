# Fable Prompt: Relay NW Security And Production Hardening

Paste everything below the line into Fable. Fable edits code, schema, docs, and tests directly. This is a production-readiness security pass, not a UX polish pass.

---

You are working directly in the **Relay NW** codebase. Treat this as a production-readiness security and reliability pass before the first paid pilot, not a UX polish pass.

You have permission to make code, schema, docs, and test changes directly. Do not stop at an audit if you find a real gap: patch it, prove it with tests, and leave the repo in a shippable state.

## Your Authority And Judgment

The priorities below are a well-researched starting map, not a cage. **You have final say over what you actually focus on.** You are working in the real codebase and will see things this brief could not anticipate. If your own investigation shows that the highest risk lives somewhere other than where this brief points, follow the risk: reprioritize, go deeper where it matters, and spend less time where the code is already sound.

You are explicitly empowered to:

- Investigate and fix high-risk issues **outside** the named scope if you find them, as long as they bear on tenant safety, compliance, data integrity, or the reliability of the core missed-call to text-back money path.
- Reorder or reweight the three priorities based on what you actually find.
- Skip or shorten any section where the code is already correct. Say so plainly and move on rather than manufacturing work.
- Decline a suggested change you judge unsafe or low-value, and explain why.

The one hard rule: **do not hide risk.** Anything you find that you do not fix must be documented as residual risk with a recommended patch plan and, where possible, a failing or skipped test that pins it.

## Context

Relay NW is a Next.js App Router app for missed-call capture, Twilio voice/SMS webhooks, Supabase, and a **manually provisioned multi-tenant** pilot model. It is close to a controlled paid beta. The operator is non-technical on the code, but sharp on the domain, and needs high-confidence proof that customer data cannot leak across accounts and that messaging/compliance/operational failures are loud, not silent.

Recent UX cleanup has already shipped. Do **not** spend time on visual polish unless you uncover a security/compliance regression in the UI.

Repo facts you can rely on:

- Test runner: `npm run test` runs `node --test tests/*.test.mjs`. Tests transpile TS modules with `ts.transpileModule` + `vm` and mock by import specifier. Match this convention for new tests; do not introduce a new test framework.
- `npm run typecheck` runs `tsc --noEmit`. `npm run lint` is an alias for typecheck.
- `npm run build` / `next build` can hang or fail in this sandbox for environment/network reasons. Do not block indefinitely on it. Verify work with `npm run typecheck` and `npm run test`, run build if practical with the repo's placeholder env pattern, and call out anything you could not verify.
- Sentry is already wired through `@sentry/nextjs`; `SENTRY_DSN` is checked in `lib/env.ts`, which warns in production when unset.
- Operational scripts already exist: `scripts/provision-account.mjs`, `scripts/verify-account.mjs`, `scripts/backfill-account-ids.mjs`, `scripts/simulate.mjs`. Extend these rather than creating parallel tooling.
- Docs already exist in `docs/`: `production-readiness.md`, `fable-production-readiness-brief.md`, `fable-security-hardening-prompt.md`, `customer-setup.md`, `pilot-onboarding.md`. Read the relevant ones first. Append residual-risk notes to `docs/production-readiness.md` rather than starting a fresh doc unless a separate doc is clearly better.

## Highest-Value Objective

Make **tenant isolation** and **compliance/operational failure handling** provable before customer #1.

Target standard: every tenant-scoped read/write fails closed without a valid `account_id`; every webhook attributes work to the correct account or loudly refuses tenant writes; every SMS compliance/failure path is auditable.

## Working Style

Be rigorous, but creative. Hunt for surprising failure modes, not just obvious TODOs:

- Can a guessed ID cross tenant boundaries?
- Can a webhook with missing or conflicting Twilio identifiers write to the wrong account?
- Can a legacy fallback or optional-column path bypass modern account scoping?
- Can a failed alert make the operator falsely believe the system is healthy?
- Can a manual owner action bypass compliance checks that automated sends obey?
- Can a migration applied in the wrong order silently create null-account rows?
- Can a "safe" unresolved-webhook path later become a tenant write?

Prefer concrete implementation over commentary: patch code when the fix is clear; add or strengthen tests whenever behavior matters; update docs/checklists when operational ordering matters; add small helper abstractions only when they reduce security risk or duplication; keep UI changes minimal and only for compliance/security visibility.

## Priority 1: Provable Tenant Isolation

Audit and harden every Supabase query path that touches customer/business data.

Key files:

- `lib/supabase/tenant.ts`
- `lib/supabase/leads.ts`
- `lib/supabase/messages.ts`
- `lib/supabase/voicemails.ts`
- `lib/supabase/calls.ts`
- `lib/supabase/webhooks.ts`
- `lib/supabase/reports.ts`
- `lib/supabase/accounts.ts`
- `lib/supabase/setup-requests.ts`
- `lib/auth.ts`
- `app/api/leads/[id]/route.ts`
- `app/api/leads/[id]/reply/route.ts`
- `app/api/leads/[id]/transcribe/route.ts`
- `app/api/recordings/[recordingSid]/route.ts`
- `app/api/settings/route.ts`
- all `app/api/twilio/*/route.ts`

Existing tests to build on:

- `tests/account-isolation.test.mjs`
- `tests/behavioral-isolation.test.mjs`
- `tests/role-enforcement.test.mjs`
- `tests/tenant-contract.test.mjs`

Do:

1. Sweep all Supabase helpers and routes for any read/update/insert/upsert/delete of tenant-owned data without an explicit account scope.
2. Ensure missing account context throws or returns a loud, controlled failure **before** touching tenant data.
3. Ensure webhook account resolution cannot silently fall back to a default/env account for production writes.
4. Decide the posture for `webhook_events` with unresolved account context: if `account_id = null` is intentional there, document it as an operational-log exception and keep tenant data tables stricter.
5. Review `supabase.sql` for DB-level enforcement: `account_id NOT NULL` where appropriate, foreign keys to `accounts`, account-scoped unique constraints where appropriate, and an explicit RLS posture.
6. If RLS is intentionally off for app writes because the server uses the service role, document that decision and confirm anon/client access cannot query tenant tables.
7. Look for legacy compatibility paths that drop newer columns/constraints, especially fallback selects/inserts that run when optional columns are missing.
8. Inspect `scripts/*.mjs` for unsafe account assumptions, not just runtime app code.

Acceptance criteria:

- Behavioral tests proving account B cannot read, mutate, play recordings from, transcribe, reply to, or delete account A data by guessing IDs.
- Tests proving two Twilio numbers map to two accounts and each creates/updates only its own calls, leads, messages, recordings, and opt-outs.
- At least one negative test that would fail if an `account_id` filter were removed from a critical helper.
- At least one schema/contract test for account-scoped constraints if you change the SQL.
- A short tenant-isolation posture and residual-risk note appended to `docs/production-readiness.md`.

## Priority 2: SMS Compliance Live-Path Hardening

Key files:

- `app/api/twilio/sms/route.ts`
- `app/api/leads/[id]/reply/route.ts`
- `lib/missed-call.ts`
- `lib/twilio.ts`
- `lib/supabase/messages.ts`
- `app/intake/intake-form.tsx`
- `app/privacy/page.tsx`
- `app/terms/page.tsx`
- `app/sms-consent/page.tsx`
- `tests/pipeline-failure-handling.test.mjs`
- `tests/tenant-contract.test.mjs`

Verify or implement:

1. STOP and common opt-out keywords are recorded **per account**.
2. Opt-out is checked before every automated **and manual** outbound SMS.
3. Opt-out lookup failures fail closed with no send.
4. HELP replies get an appropriate automatic response if required for A2P/compliance.
5. START/UNSTOP is handled deliberately or documented as delegated to Twilio.
6. Consent capture is persisted/auditable where the product claims consent.
7. Message templates carry opt-out/help language where required.
8. Compliance holds across both missed-call auto-SMS and manual owner replies.
9. Account-level `sms_enabled` / A2P readiness cannot be bypassed by an alternate send path.

Acceptance criteria:

- Tests prove STOP for account A does not opt the same phone out of account B.
- Tests prove manual owner replies cannot bypass opt-out.
- Tests prove HELP behavior, or document why it is intentionally delegated.
- Tests prove opt-out/cooldown check failures are visible and send nothing.
- Any HELP/START behavior you add includes webhook-response tests returning valid TwiML.

## Priority 3: Silent-Failure Observability

Audit the money path for failures that could leave a customer believing Relay worked when it did not:

- missed-call creation
- call forwarding/dial status
- missed-call SMS send
- SMS status callbacks
- inbound replies
- voicemail recording
- transcription
- owner/admin notifications
- weekly digest/cron

Verify or implement:

1. Every failure that could lose a lead, suppress an SMS, block transcription, or break webhook attribution is logged durably or sent as an admin/owner alert.
2. `SENTRY_DSN` coverage is real for server routes, not just nominal.
3. Admin email/alert failures do not break customer-facing flows but stay visible in logs.
4. Webhook event logging sanitizes sensitive payloads while preserving debug metadata.
5. Production env warnings are actionable and documented.
6. Failures reach the right audience: admin/operator for misconfig, owner for lead-specific action, webhook log for Twilio forensics, Sentry/server logs for unexpected exceptions.
7. Alerting itself fails soft for customer-facing flows but never disappears silently.

Acceptance criteria:

- Tests prove critical failures are not silent.
- `docs/production-readiness.md` lists which failures alert admin, owner, Sentry, webhook log, or server log; if a failure is intentionally not alerted, say why.

## Optional High-Leverage Extras

Only if the top three priorities are solid, use judgment. Good targets:

- Extend `scripts/verify-account.mjs` or `scripts/simulate.mjs` into a pre-deploy check for env, schema prerequisites, provisioning, Twilio registration, and alerting.
- Add a two-account end-to-end simulation.
- Tighten migration/runbook ordering so code cannot ship before SQL, or SQL before backfill, in the wrong order.
- Harden invite/provisioning if account setup can strand a pilot owner.

Avoid extras that are mostly product polish.

## Constraints

- Do not rewrite the architecture unless you find a catastrophic risk unfixable locally. If so, stop and document the smallest safe migration path.
- No UI polish, labels, or styling unless directly needed for security/compliance visibility.
- Keep changes small, testable, production-safe.
- **Preserve the customer-facing Twilio experience: webhook routes must return valid TwiML/200 where appropriate to avoid bad caller experiences and Twilio retry storms.**
- No new third-party services unless absolutely necessary.
- Do not weaken existing tests to make a change pass.
- Do not hide risk behind comments. Fix it, test it, or document it as residual risk.

## Verification

Run:

```bash
npm run test
npm run typecheck
```

Also run any new targeted test files. Run `npm run build` if practical, but do not block indefinitely on it in the sandbox. Let Vercel verify the production build if local build is blocked, and note anything you could not confirm. Use the repo's existing env-placeholder pattern if needed. Separate expected warnings from real failures.

## Deliverables

1. Code changes for confirmed security/compliance/observability gaps.
2. Focused tests proving the fixes, matching the `node --test` + `loadTsModule` convention.
3. A short summary:
   - what was already safe
   - what was unsafe or ambiguous
   - what you changed
   - what remains as residual risk before customer #1
4. Any production-checklist updates needed before the first paid pilot.
5. A clear final verdict: whether Relay NW is safe for a supervised first pilot, and the exact checks that must still happen in production before enabling live customer SMS.

Remember: this map is a starting point. If your investigation points somewhere more important, go there and tell the operator plainly why.

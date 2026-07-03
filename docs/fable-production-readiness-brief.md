# Relay NW Production Readiness Brief

Prepared for Fable

## Summary

Relay NW is ready for a small, supervised paid beta with 1-3 friendly businesses. It is not yet ready for broad self-serve production sales.

The app has meaningful production hardening already in place: account-scoped data access, Twilio signature validation, missed-call idempotency, SMS cooldowns, opt-out handling, webhook event logs, voicemail recording/transcription handling, owner/admin/viewer roles, and a focused test suite around the highest-risk flows.

The next work should focus less on new product features and more on operational readiness: environment completeness, production schema application, pilot account verification, live Twilio/Supabase/Vercel checks, alerting, and documentation alignment.

## Verified Current State

- Git worktree is clean on `main`.
- `npm run test` passes: 65/65 tests.
- `npm run typecheck` passes.
- `npm run build` passes when required environment variables are present and network access is available for Google Fonts.
- Local `.env.local` is stale/incomplete compared with `.env.example`.
- Production build fails without `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which is expected because Supabase Auth is required.
- The build emits production warnings when alerting and monitoring env vars are missing:
  - `RESEND_API_KEY`
  - `ADMIN_ALERT_EMAIL`
  - `SENTRY_DSN`

## Current Readiness Assessment

### Good For Controlled Beta

- Supabase Auth protects owner-facing pages.
- Human access resolves through `account_users -> account_id`.
- Authenticated account routes are tested for tenant isolation.
- Viewer role is read-only for mutating actions.
- Twilio webhook routes validate signatures unless unsigned webhooks are explicitly allowed for local testing.
- `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=true` is blocked in production.
- Twilio number resolution maps webhooks to accounts through `account_phone_numbers`.
- Missed-call lead creation is idempotent per account.
- SMS cooldown includes pending and active delivery states.
- STOP-style opt-outs are stored and respected.
- SMS status callbacks update/reconcile leads and message rows.
- Webhook logs use sanitized payload metadata.
- Voicemail recording/transcription failure modes are handled and tested.
- Local scripts exist for account provisioning and account verification.

### Not Yet Broad Production Ready

- Onboarding is still manual and founder-operated.
- Production env completeness needs to be verified.
- Latest `supabase.sql` must be applied to production.
- Each customer still needs a real end-to-end test before charging.
- Alerting/monitoring must be configured before live pilots.
- A2P 10DLC status must be tracked carefully before enabling customer SMS.
- README has documentation drift: it still describes the app as single-business / not multi-business, while the code and pilot docs now support manually provisioned multi-tenant pilots.

## Immediate Blockers Before First Paying Pilot

1. Apply the latest `supabase.sql` in the production Supabase project.
2. Make production env vars complete and current:
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER`
   - `OWNER_PHONE_NUMBER`
   - `APP_BASE_URL`
   - `INTAKE_URL`
   - `SCHEDULING_URL`
   - `BUSINESS_NAME`
   - `CALL_MODE`
   - `SMS_ENABLED`
   - `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=false`
3. Configure operational visibility:
   - `SENTRY_DSN`
   - `RESEND_API_KEY`
   - `ALERT_FROM_EMAIL`
   - `ADMIN_ALERT_EMAIL`
   - `CRON_SECRET`
4. Verify production build and deployment after env changes.
5. Provision and verify the first pilot account.
6. Run one real end-to-end missed-call flow before charging.

## Recommended Production Readiness Path

### Phase 1: Environment And Deployment

- Sync `.env.local`, Vercel production env, and `.env.example`.
- Remove stale local-only assumptions such as old password-based auth references.
- Confirm Vercel production has `ALLOW_UNSIGNED_TWILIO_WEBHOOKS` unset or set to `false`.
- Confirm `APP_BASE_URL` and `INTAKE_URL` point to the production domain.
- Confirm `CRON_SECRET` is set so `/api/digest/weekly` can run securely.
- Run:

```bash
npm run typecheck
npm run test
npm run build
```

### Phase 2: Database And Account Verification

- Apply `supabase.sql` in production.
- Provision the pilot account:

```bash
ACCOUNT_SLUG="customer-slug" \
BUSINESS_NAME="Customer Business" \
OWNER_PHONE_NUMBER="+15557654321" \
TWILIO_PHONE_NUMBER="+15551234567" \
INTAKE_URL="https://www.relay-nw.com/intake" \
OWNER_EMAIL="owner@example.com" \
CALL_MODE="forwarding" \
SMS_ENABLED="false" \
npm run provision:account
```

- Create/invite the same owner email in Supabase Auth.
- Verify the account:

```bash
npm run verify:account -- customer-slug
```

The verification should confirm:

- Account exists.
- Account is active.
- `account_settings` exists.
- Primary `account_phone_numbers` row exists.
- Twilio number is not a placeholder.
- Owner/admin email exists.
- Owner phone is not a placeholder.
- SMS is disabled unless A2P is approved.
- At least one owner/admin Supabase Auth user is linked or intentionally pending first login.

### Phase 3: Twilio And A2P

- Configure Twilio number webhooks:
  - Voice webhook: `https://www.relay-nw.com/api/twilio/voice`
  - Messaging webhook: `https://www.relay-nw.com/api/twilio/sms`
  - Method: `POST`
- Confirm SMS status callbacks are generated by the app as expected.
- Confirm the Relay Twilio number is registered in `account_phone_numbers`.
- Track A2P 10DLC status in `account_settings.a2p_registration_status`.
- Keep `SMS_ENABLED=false` until A2P is approved or a controlled test is explicitly planned.

### Phase 4: Live Pilot Acceptance Test

For each pilot customer, run this with the owner watching:

- Owner can sign in at `/login`.
- Owner can only see their account data.
- Customer calls the existing business number.
- Owner does not answer.
- Carrier forwards the missed call to the Relay Twilio number.
- Caller hears the greeting.
- Caller leaves a voicemail.
- Lead appears in `/leads`.
- Voicemail appears on the lead.
- Voicemail transcription works if `OPENAI_API_KEY` is configured.
- Missed-call SMS sends only when SMS/A2P readiness allows it.
- SMS status callback updates the lead/message state.
- Customer replies to the SMS.
- Inbound reply appears in the lead conversation.
- Owner receives the forwarded reply/notification.
- STOP opt-out suppresses future SMS for that account.
- Recent Twilio activity shows call, recording, SMS, and status events.
- Sentry captures a forced server-side test error.
- Admin alert email is received for a controlled operational failure or test route.

## Documentation Cleanup

Update README to match the current architecture.

Current issue:

- README still says the app is intentionally single-business and does not support multi-business/user accounts.
- The code now supports manually provisioned multi-tenant pilots through `accounts`, `account_settings`, `account_phone_numbers`, and `account_users`.

Recommended positioning:

> Relay NW supports manually provisioned multi-tenant pilots. It is not yet a self-serve multi-business SaaS. Each customer must be onboarded and verified by the operator.

Also update the "Not In V1" section to avoid saying "multi-business support" and "user accounts" are absent. A better distinction:

- Not in V1:
  - Self-serve signup
  - Automated customer onboarding
  - Billing
  - Full CRM automation
  - Advanced analytics
  - Business-hours routing
  - Multi-user team administration beyond owner/admin/viewer basics

## Suggested Priority Order

1. Env and deployment verification.
2. Apply production schema.
3. Configure Sentry, Resend, admin alerts, and cron secret.
4. Clean README drift.
5. Provision first pilot account.
6. Run `npm run verify:account -- <slug>`.
7. Configure Twilio webhooks and A2P status.
8. Run one real missed-call/voicemail/SMS/reply/opt-out test.
9. Keep the first week supervised through `/leads`, webhook activity, Twilio logs, Sentry, and admin alerts.
10. Only then add another pilot.

## Recommendation

Do not build major new features before the first pilot. The highest-leverage work is making setup, verification, alerting, and recovery repeatable.

The product is close enough to learn from real businesses now, but only with hands-on onboarding and close monitoring.

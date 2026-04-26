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

- If Twilio accepts an SMS but the DB update fails, the recent webhook event now makes that visible, but the lead row may still stay `pending`.
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

Status: Partially done. The status is now visible in webhook logs, but the lead row can still remain stale if Supabase update fails.

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

# Relay NW Ops Runbook

Use this when Relay NW is live for a business and something important may have failed. The goal is simple: protect the missed-call recovery loop, notify the right person, and avoid silently losing caller data.

## Operator Boundary

`/ops/*` is an internal Relay Operations surface. A Relay operator is an active row in `platform_operators`, not merely an `owner` or `admin` on any customer account.

- Customer owners should use `/leads`, `/setup`, `/settings`, and `/reports`.
- The initial platform operator is bootstrapped by `supabase.sql` from the Supabase Auth email `srlowry21@gmail.com`.
- Add future operators deliberately to `platform_operators` with role `super_admin`, `operator`, or `support`; revoke access by setting `status='revoked'`.
- Do not grant Operations access by adding someone to a house-account `account_users` row. Account membership and platform access are separate concerns.
- `/ops` is the account directory. Choose a customer before opening technical logs or Billing & setup.
- Billing and onboarding forms carry the selected account server-side; never use an owner account cookie to decide which customer gets changed.

## First Response

1. Open `/ops`, search for the affected customer, and choose the account.
2. Search by `CallSid`, `MessageSid`, `RecordingSid`, caller last 4, or webhook source.
3. Open the lead inbox and confirm whether the caller has a lead.
4. Check the lead card for `sms_status`, voicemail status, transcript status, and any visible error.
5. If caller follow-up may have failed, tell the owner to call the lead manually.

## Core Loop Checks

For every live account, the healthy path is:

1. Twilio voice or dial-status webhook resolves to the account.
2. A lead is created once for the missed call.
3. Automatic SMS sends only when A2P is approved and `sms_enabled=true`.
4. Twilio SMS status callback updates the lead/message row.
5. Inbound caller replies are stored and forwarded to the owner.
6. Recording callback attaches voicemail to the lead.
7. Voicemail transcription completes or fails visibly.

Run `npm run test:activation` locally before high-risk releases. This is deterministic proof of the app flow, not proof that carriers delivered a real SMS.

## Failure Playbooks

### Assisted Onboarding Queue

- Open `/ops/setup-requests` as an active platform operator.
- Move each request through `New`, `Contacted`, `Onboarded`, or `Closed`.
- Provision real customer accounts with `npm run provision:account`; do not manually recreate the same rows from memory.
- Verify every customer account with `npm run verify:account -- <slug>` before handing over access.
- Use `/setup` with the owner for forwarding instructions, forwarding health checks, SMS test, and setup status.
- When customer requirements are requested, use `/ops/billing` to start or reopen the customer-delay clock. This marks the account `waiting_on_customer` with a `requirements_due_at` 14 days out and records an audit event.
- `/api/cron/onboarding-deadlines` handles day-3/day-7 reminders, pauses incomplete onboarding after day 14, and closes incomplete onboarding after day 30.
- Carrier review and carrier attention are not customer-delay states; do not penalize the owner for carrier-caused delays.
- Reopening a closed incomplete onboarding requires operator action, a new requirements deadline, and does not reset the original guarantee period.

### Commercial Terms and Activation Billing

- New accounts start with a one-time `$150 setup fee` due. Existing pilot/house accounts are backfilled as explicitly waived by the Phase 7C migration.
- A pilot waiver must be made from the selected account in `/ops/billing`, include a short reason, and remain visible in the account audit history. A waiver never starts monthly billing.
- Monthly billing is `$99/month` and is allowed only after call capture and A2P registration are ready. The owner or operator may open Stripe Checkout only after the setup fee is paid or waived.
- Customer delay and carrier delay are separate: do not start the customer deadline clock for `carrier_review` or `carrier_attention`.
- Standard monthly Checkout has no automatic trial. Use the existing bounded manual trial controls only for an intentional, audited exception.
- Configure a separate Stripe one-time Price for `STRIPE_SETUP_FEE_PRICE_ID`. The existing `STRIPE_PRICE_ID` remains the recurring monthly Price.
- The Stripe webhook must include `checkout.session.completed`; setup-fee sessions carry `metadata[charge_type]=setup_fee` and never mark a subscription active.
- If setup-fee payment succeeds, confirm the account shows `setup_fee_status=paid`. If it is waived, confirm `setup_fee_status=waived` and the waiver reason. If monthly billing is active, confirm the subscription event separately.

### SMS Failed, Undelivered, or Not Sent

- If `sms_status=failed` or `undelivered`, tell the owner to call the lead.
- Open that account's Technical logs from `/ops` and check `twilio_sms_status` plus the `MessageSid`.
- If `sms_status=skipped_disabled`, confirm whether the owner intentionally paused automatic texting.
- If A2P is not approved, keep SMS off and treat the account as calls-ready only.
- If Twilio accepted the SMS but the lead update failed, wait for the status callback to reconcile through the messages table. If it does not reconcile, search `/ops` by `MessageSid`.

### Missing Lead

- Search `/ops` by `CallSid` and caller last 4.
- If the webhook is unresolved, verify the account's Twilio number routing and `account_phone_numbers` row.
- If a lead was not created, call the owner and manually capture the caller details from Twilio if available.

### Voicemail or Transcription Failed

- If a recording exists but the summary failed, the owner can still listen to the voicemail.
- Check `/ops` for `twilio_recording`.
- If transcription failed transiently, run the retry cron or wait for the scheduled retry.
- If Twilio no longer has the recording, mark the lead as needing manual follow-up and do not promise recovery.

### Alert Email Not Received

- Check `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `ADMIN_ALERT_EMAIL`, and Sentry.
- Admin operational alerts are the backstop for SMS, persistence, and transcription failures.
- If alerting is down, monitor `/ops` manually for active pilot accounts until fixed.

## Privacy and Retention

- Do not paste full caller messages, transcripts, or recordings into support notes unless needed to resolve an issue.
- Use caller last 4, `CallSid`, `MessageSid`, and `RecordingSid` for debugging when possible.
- Webhook debug logs are sanitized and pruned by `WEBHOOK_EVENT_RETENTION_DAYS`.
- Inbound SMS bodies are pruned by `INBOUND_MESSAGE_RETENTION_DAYS`.
- Voicemail recordings, transcripts, and lead records are retained until manually deleted or until automated recording retention is implemented.
- For a deletion request, identify the account, lead, caller phone, recording SID, message SIDs, and any opt-out rows before deleting.

## Backup, Restore, and Deletion

Before destructive support work, export the affected account rows from Supabase:

- `accounts`
- `account_settings`
- `account_phone_numbers`
- `account_users`
- `leads`
- `messages`
- `inbound_messages`
- `opt_outs`
- `calls`
- `forwarding_health_checks`
- relevant sanitized `webhook_events`

For restore work, reinsert the smallest affected set of rows, then run `npm run verify:account -- <slug>` and inspect `/ops` for unresolved webhook or delivery failures.

For deletion work, identify the account slug, lead id, caller phone, `RecordingSid`, `MessageSid` values, and opt-out rows before deleting. Record the support action with IDs and caller last 4; avoid storing full transcript/SMS content in notes unless it is necessary to resolve the incident.

## Release Checklist

Before handing a business live access:

1. `npm run verify:account -- <slug>`
2. `npm run verify:billing`
3. `npm run verify:launch -- <slug>`
4. On a scratch account only, run `npm run verify:billing-controls -- <scratch-slug>` after operator billing changes.
5. For one combined launch pass, run `npm run verify:launch -- <slug> --billing-controls <scratch-slug>`.
6. `npm run test:activation`
7. One real missed-call test through Twilio.
8. One Stripe test-mode Checkout for the launch account or a matching sandbox account.
9. Confirm `/ops` shows the voice/dial-status, SMS status, inbound reply, recording, and Stripe events.
10. Confirm privacy and terms links are visible from intake/setup flows.

`verify:billing` is read-only. It confirms the Stripe price is the $99 monthly plan, Customer Portal is active, and the production webhook endpoint is enabled for every billing event Relay NW processes.

`verify:launch` is also read-only. It ties the account, setup readiness, SMS mode, billing state, Stripe config, Checkout eligibility, and Portal availability into one launch decision. Treat a paused SMS warning as an operating choice, not a setup failure, but make sure the owner understands callers are not getting automatic replies.

The optional `--billing-controls <scratch-slug>` launch flag runs a separate scratch-only billing-control rehearsal after the read-only launch checks. It refuses non-scratch slugs and accounts with live Stripe subscriptions, then snapshots and restores billing fields by default after proving comp, uncomp, trial grant, and app-trial expiry. Use `--keep-state` only if you intentionally want to leave the scratch account at the final rehearsal state.

# Relay NW Ops Runbook

> **Phase 0 transition note:** this runbook describes the current production
> runtime. The approved target delays monthly trial start until automatic
> text-back activation and adds explicit blocker ownership. Do not use those
> target rules operationally until their matching implementation phases ship.
> See `docs/strategy/BILLING-OPERATIONS-SIMPLIFICATION.md`.

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
- New requests must include the owner login email. `Accept and invite` creates a separate tenant, owner membership, and secure password-setup email in one audited action.
- Acceptance leaves the `$150` setup fee due, assigns no Relay number, and starts no monthly billing. Never reuse an operator account as the customer account.
- Use `Resend account invite` if delivery fails. Relay sends the custom password email through Resend so Supabase's hosted-email rate limit is not part of normal onboarding.
- Verify every customer account with `npm run verify:account -- <slug>` before handing over access.
- Reuse the business name, owner login/contact, call mode, and public number already collected at intake. Do not ask the customer to re-enter carrier-registration details in the app.
- Assign an owned Twilio number from the account page after acceptance, or deliberately purchase one there. Purchasing creates a real Twilio charge.
- Help forwarding customers complete the one carrier-specific forwarding step on `/setup`. Do not run synthetic forwarding or SMS tests.
- The first signed, newly inserted real missed call marks call capture `live`. A2P work is separate and happens primarily in Twilio.
- If a customer stops onboarding, an operator may explicitly pause or close the account. Relay does not run an automatic customer-deadline clock.

### Commercial Terms and Activation Billing

- New accounts start with a one-time `$150 setup fee` due. Existing pilot/house accounts are backfilled as explicitly waived by the Phase 7C migration.
- A pilot waiver must be made from the selected account in `/ops/billing`, include a short reason, and remain visible in the account audit history. A waiver never starts monthly billing.
- Monthly billing is `$99/month` and becomes available when call capture is `live`. A2P approval and setup-fee status do not act as hidden monthly-billing gates.
- Standard customer subscriptions start through Stripe-hosted Checkout. Do not create subscriptions from a locally stored payment-method reference.
- Configure a separate Stripe one-time Price for `STRIPE_SETUP_FEE_PRICE_ID`. The existing `STRIPE_PRICE_ID` remains the recurring monthly Price.
- Stripe webhooks are the immediate source for payments, cancellations, refunds, disputes, and deleted customers. `/api/cron/billing-reconciliation` re-reads all connected Stripe records daily as a repair path when an event is delayed or missed.
- If setup-fee payment succeeds, confirm `paid`. A partial/full refund or dispute must appear after its Stripe event or after `Sync with Stripe`. Never change a payment to refunded only in Relay.
- Only a super admin can issue a real setup-fee refund from Relay. Waivers and refunds are different actions and remain separately audited.
- Customers manage payment methods, invoices, and cancellation through Stripe Customer Portal from Settings. A deleted or wrong-mode Stripe customer is cleared and presented as a relink path instead of an error loop.
- A scheduled cancellation remains live until the paid period ends. A failed payment shows a customer action but does not automatically disable missed-call capture without a separately approved grace-period policy.

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
- relevant sanitized `webhook_events`

For restore work, reinsert the smallest affected set of rows, then run `npm run verify:account -- <slug>` and inspect `/ops` for unresolved webhook or delivery failures.

For deletion work, identify the account slug, lead id, caller phone, `RecordingSid`, `MessageSid` values, and opt-out rows before deleting. Record the support action with IDs and caller last 4; avoid storing full transcript/SMS content in notes unless it is necessary to resolve the incident.

## Release Checklist

Before handing a business live access:

1. `npm run verify:account -- <slug>`
2. `npm run verify:billing`
3. `npm run verify:launch -- <slug>`
4. `npm run test:activation`
5. One real missed-call test through Twilio.
6. One Stripe test-mode Checkout for the launch account or a matching sandbox account.
7. Confirm `/ops` shows the voice/dial-status, SMS status, inbound reply, recording, and Stripe events.
8. Confirm privacy and terms links are visible from intake/setup flows.

`verify:billing` is read-only. It confirms the Stripe prices are the `$99/month` recurring plan and the `$150` one-time setup fee, Customer Portal is active, and the production webhook endpoint is enabled for every billing event Relay NW processes.

`verify:launch` is also read-only. It ties the account, setup readiness, SMS mode, billing state, Stripe config, Checkout eligibility, and Portal availability into one launch decision. Treat a paused SMS warning as an operating choice, not a setup failure, but make sure the owner understands callers are not getting automatic replies.

There is no app-managed trial or operator-created subscription rehearsal. Test the customer-owned Stripe Checkout path in Stripe test mode instead.

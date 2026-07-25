# Relay NW Ops Runbook

> **Current operating contract:** Stripe-owned delayed trials and the Phase 2
> independent Operations states are live. Calls, Texting, Billing, and blocker
> ownership are separate facts; the queue and next action are derived.

Use this when Relay NW is live for a business and something important may have failed. The goal is simple: protect the missed-call recovery loop, notify the right person, and avoid silently losing caller data.

## Operator Boundary

`/ops/*` is an internal Relay Operations surface. A Relay operator is an active row in `platform_operators`, not merely an `owner` or `admin` on any customer account.

- Customer owners should use `/leads`, `/setup`, `/settings`, and `/reports`.
- The initial platform operator is bootstrapped by `supabase.sql` from the Supabase Auth email `srlowry21@gmail.com`.
- Add future operators deliberately to `platform_operators` with role `super_admin`, `operator`, or `support`; revoke access by setting `status='revoked'`.
- Do not grant Operations access by adding someone to a house-account `account_users` row. Account membership and platform access are separate concerns.
- `/ops` is the one derived Work queue: Needs attention, Onboarding, Running,
  then collapsed Paused or closed. Choose a customer before opening technical
  logs or Billing & setup.
- `/ops/accounts` is the searchable directory, not a second pipeline. Old
  `/ops/customers` and `/ops/setup-requests` links redirect to the new places.
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

- Open `/ops` as an active platform operator. New setup requests are the first
  cards in the Onboarding group.
- New requests must include the owner login email. `Accept and invite` creates a separate tenant, owner membership, and secure password-setup email in one audited action.
- Acceptance leaves the `$150` setup fee due, assigns no Relay number, and starts no monthly billing. Never reuse an operator account as the customer account.
- Use `Resend account invite` if delivery fails. Relay sends the custom password email through Resend so Supabase's hosted-email rate limit is not part of normal onboarding.
- Verify every customer account with `npm run verify:account -- <slug>` before handing over access.
- Reuse the business name, owner login/contact, call mode, and public number already collected at intake. Do not ask the customer to re-enter carrier-registration details in the app.
- Assign a number already owned by the configured Twilio account. Number
  purchasing stays outside Relay so an operator action cannot create an
  unexpected Twilio charge.
- Help forwarding customers complete the one carrier-specific forwarding step on `/setup`. Do not run synthetic forwarding or SMS tests.
- The first signed, newly inserted real missed call marks call capture `live`. A2P work is separate and happens primarily in Twilio.
- Copy the Messaging Service and A2P Campaign SIDs into the account workspace,
  then use **Sync from Twilio**. The external campaign result controls A2P;
  operators cannot select Approved.
- Record whether Relay, the customer, or the carrier owns any blocker and include the specific reason. Blocker age is visible but does not create an automatic deadline.
- Operators may explicitly pause call setup. They cannot manually mark calls ready, approve A2P, or invent a Stripe state.
- Clearing a blocker clears its note and age; it does not change Calls, Texting, or Billing.

### Operations Queue

Every account exposes four independent facts:

- **Calls:** setting up, waiting for forwarding, ready, or paused. A signed real missed call is the only positive readiness proof.
- **Texting:** preparing, carrier review, approved, or issue. Relay reads the
  Twilio campaign result; Twilio/carrier status is authoritative.
- **Billing:** setup due, card needed, card ready, free access, trial, active, attention, or canceled. “Card needed” means the setup fee is already settled and only Stripe’s no-charge card form remains. “Free access” is an audited Relay policy and never invents a Stripe subscription.
- **Blocked by:** none, Relay, customer, or carrier. Relay operators own only this explanation and explicit call holds.

Relay derives one queue group and one next action; neither is stored or directly
editable. The precedence is: explicit blocker, paused calls, Stripe attention
or cancellation, texting issue, commercial setup, call setup, A2P work,
automatic text-back activation, then delayed trial activation. A healthy
Stripe trial, active subscription, or audited comp needs no action.

### Operator action boundary

| Actor | Allowed in Relay |
|---|---|
| Support | Read accounts and diagnostics |
| Operator | Edit setup/customer details; attach an existing Twilio number; synchronize A2P from Twilio; set/clear blockers; send Stripe setup/card links; pause or resume onboarding; request the gated initial-trial operation |
| Super admin | All operator actions; confirmed setup-fee waivers and comps; close/reopen accounts; explicitly pause paid service |
| Stripe | Payment methods, invoices, refunds, retries, disputes, and cancellation |

Commercial exceptions require a meaningful reason and explicit confirmation.
Successful exceptions have an account audit event from the policy RPC and a
required platform authorization event. Support routes render without mutation
controls, and every mutation endpoint rechecks its action permission.

### Commercial Terms and Activation Billing

- Standard accounts start with a one-time `$150 setup fee` due. Founding pilots
  are an explicit commercial offer with an audited setup-fee waiver and a
  30-day trial.
- A super admin can instead start free pilot access. It creates no setup
  charge, card requirement, or Stripe subscription. The super admin may choose
  an optional review date or leave it open-ended; a review never charges or
  stops service automatically.
- A pilot waiver must be made from the selected account, include a short
  reason, and remain visible in the account audit history. It is never shown as
  paid or refunded.
- Standard setup Checkout charges `$150` and retains the card in Stripe with
  reuse disclosure. Founding-pilot card Checkout charges nothing.
- Monthly service is `$99/month`. The initial Stripe-owned trial is 14 days for
  standard customers and 30 days for founding pilots.
- Trial creation uses one idempotent Stripe operation only after calls are live, A2P is
  approved, automatic text-back is enabled, the setup terms are settled,
  Stripe has a default payment method, the account is not paused or closed, no
  operational blocker is present, and Stripe has no active or incomplete
  subscription.
  Calls alone never start trial time.
- Subscription Checkout is only for a canceled customer restarting after the
  one-time trial. Never grant a second trial.
- Configure a separate Stripe one-time Price for `STRIPE_SETUP_FEE_PRICE_ID`. The existing `STRIPE_PRICE_ID` remains the recurring monthly Price.
- Stripe webhooks are the immediate source for payments, cancellations, refunds, disputes, and deleted customers. `/api/cron/billing-reconciliation` re-reads all connected Stripe records daily as a repair path when an event is delayed or missed.
- If setup-fee payment succeeds, confirm `paid`. A partial/full refund or dispute must appear after its Stripe event or after `Sync with Stripe`. Never change a payment to refunded only in Relay.
- Relay never executes a refund. A super admin follows the selected payment
  link into Stripe, where Stripe permissions and confirmation control the
  refund. Relay reflects the result only from signed Stripe events or
  reconciliation.
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

For an actual pilot, complete
[`docs/pilot-certification-checklist.md`](pilot-certification-checklist.md);
the list below is the release-level preflight.

Before handing a business live access:

1. `npm run verify:account -- <slug>`
2. `npm run verify:billing`
3. `npm run verify:launch -- <slug>`
4. `npm run test:activation`
5. One real missed-call test through Twilio.
6. One Stripe test-mode Checkout for the launch account or a matching sandbox account.
7. Confirm `/ops` shows the independent Calls, Texting, Billing, and Blocked-by facts plus the expected derived action.
8. Confirm the account diagnostics show the voice/dial-status, SMS status, inbound reply, recording, and Stripe events.
9. Confirm privacy and terms links are visible from intake/setup flows.

`verify:billing` is read-only. It confirms the Stripe prices are the `$99/month` recurring plan and the `$150` one-time setup fee, Customer Portal is active, and the production webhook endpoint is enabled for every billing event Relay NW processes.

`verify:launch` is also read-only. It ties the account, setup readiness, SMS mode, billing state, Stripe config, Checkout eligibility, and Portal availability into one launch decision. Treat a paused SMS warning as an operating choice, not a setup failure, but make sure the owner understands callers are not getting automatic replies.

There is no app-managed trial or operator-invented subscription state. In
Stripe test mode, test setup/card Checkout, activate automatic text-back, then
confirm Stripe created the correct delayed trial.

## A2P status authority

Relay must never treat a campaign-level `VERIFIED` response by itself as proof
that a customer's Relay number can send A2P traffic. Operations may display
`Approved` only after the Twilio synchronization confirms all of the following:

- the supplied campaign belongs to the supplied Messaging Service and is verified;
- Twilio reports that Messaging Service as A2P registered;
- the account's exact assigned Relay number is in that Messaging Service's sender pool;
- Twilio reports that assigned number as SMS capable.

If any piece of evidence is absent, synchronization leaves texting in review or
marks it as needing attention. Operators cannot manually select `Approved`.
Twilio Console remains the final diagnostic source for the backend number
registration states (`REGISTERED`, pending, failed, or unregistered).

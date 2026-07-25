# Pilot Certification Checklist

Use this checklist for each pilot immediately before enabling automatic
text-back. Record the date, operator, account slug, Stripe mode, and links to
the account and relevant Stripe records. Never use a live charge, refund,
subscription, cancellation, Twilio-number purchase, or customer message as a
test without explicit approval.

## Read-only preflight

- [ ] `npm run verify:account -- <slug>` passes. Record warnings separately.
- [ ] `npm run verify:billing` passes against the environment being certified.
- [ ] `npm run verify:launch -- <slug>` passes.
- [ ] `npm run test:activation` passes.
- [ ] Operations shows one derived next action and the correct blocker owner,
  note, and age.
- [ ] The account is active, not paused or closed, and has no unresolved
  customer, Relay, or carrier blocker.

## Commercial and Stripe evidence

- [ ] **Card collected:** Stripe shows a reusable default payment method for
  this account's Stripe Customer. Relay did not store card details.
- [ ] **Setup terms resolved:** a standard customer has a successful, exact
  USD `$150` setup PaymentIntent, or a founding pilot has the super-admin
  waiver reason in both account and platform audit history. A waiver is not
  labeled paid or refunded.
- [ ] **Correct tenant and mode:** Customer, PaymentIntent or SetupIntent, and
  Subscription metadata use this account ID and are all in the intended Stripe
  test or live mode.
- [ ] **No competing subscription:** Stripe has no unrelated active, trialing,
  incomplete, past-due, unpaid, or paused subscription for this customer.

## End-to-end service evidence

- [ ] **Call captured:** one signed real missed call created exactly one lead
  for this account and Calls reads `ready`.
- [ ] **A2P approved:** Twilio reports the campaign `VERIFIED`; Relay shows
  Texting `approved`. Approval was synchronized from Twilio, not selected
  manually.
- [ ] **Automatic text sent:** after explicit activation approval, the missed
  caller received the expected automatic text and Relay recorded the Twilio
  MessageSid and delivery status.
- [ ] **Caller reply received:** a reply from that caller appears in the
  correct account conversation and reaches the configured owner notification
  path.
- [ ] **Trial created:** Stripe shows `trialing`, `$99/month`, and exactly 14
  days for a standard customer or 30 days for a founding pilot. Trial start is
  no earlier than automatic text-back activation.

## Customer billing controls

- [ ] **Portal opens:** the owner can open Stripe Customer Portal from Relay
  and sees only their payment method, invoices, and subscription.
- [ ] **Cancellation is understandable:** Portal offers cancellation at period
  end. In Stripe test mode or an approved sandbox account, scheduling
  cancellation leaves Relay running through the displayed end date and Relay
  says “scheduled to end,” not already canceled.
- [ ] **Payment failure is understandable:** using Stripe test mode, a fixture,
  or a test clock, `invoice.payment_failed`,
  `invoice.payment_action_required`, or `invoice.finalization_failed` produces
  Billing `attention` and a secure Manage billing path. It must not erase
  canceled truth or affect call capture.
- [ ] **Recovery works:** a later positive `invoice.paid` event restores the
  Stripe-synchronized active state without an operator manually setting it.

## Stop conditions

Do not certify the pilot if any item above lacks evidence, if a production
secret is missing, if webhook signatures are bypassed, if test/live modes are
mixed, or if Stripe/Twilio identifiers resolve to conflicting accounts. Leave
automatic text-back off, set the accurate blocker owner and reason, and record
the follow-up action in Operations.

Certification is complete only when every required item is checked and the
operator records:

- Account slug:
- Commercial offer:
- Stripe mode:
- Certified by:
- Certified at:
- Evidence or incident links:

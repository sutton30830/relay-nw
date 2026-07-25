# Relay Customer Setup

Relay onboarding has two customer-visible phases. Billing is separate.

## Phase 1: Get calls live

Relay needs:

- Business display name
- Owner login email
- Owner phone number
- Call mode (`forwarding` or `direct`)
- Existing public business number only for forwarding accounts

Most of this arrives through the public intake request. Do not ask the customer
to enter it again.

### Operator steps

1. Accept the request from the top of Onboarding in `/ops`.
2. Provision the account and owner login.
3. Assign the account's Relay/Twilio number.
4. Configure the Twilio voice and messaging webhooks.
5. For forwarding accounts, help the customer enable conditional forwarding
   using the instructions on `/setup`.

The customer does not run an app-generated test. The first valid, signed, real
missed call that creates a new CRM lead automatically marks call capture
`live`.

Confirm:

- The missed call appears once in `/leads`.
- Voicemail is attached when the caller leaves one.
- `/setup` says calls are live.
- Duplicate or unsigned webhooks do not change setup state.

Automatic texting may still be unavailable. That does not block calls or CRM
access, and it does not consume monthly trial time.

## Phase 2: Enable texting

Relay collects registration details directly from the customer and completes
A2P registration in Twilio. Do not send the customer through an in-app carrier
questionnaire.

The customer sees only a calm texting status:

- Relay is preparing or enabling texting.
- Texting is available.
- Relay is resolving a texting issue.
- Texting is unavailable.

Only A2P status `approved` permits the owner to turn automatic texting on.
Approval never turns texting on automatically.

## Billing

Billing is not an onboarding phase:

- Setup costs $150 once unless Relay explicitly waives it.
- Service costs $99 per month unless Relay explicitly comps the account.
- Standard customers pay the $150 setup fee through Stripe; founding pilots
  receive an audited waiver and add a card through a no-charge Stripe form.
- The initial Stripe-owned trial is 14 days for standard customers and 30 days
  for founding pilots.
- Trial time starts only after calls are live, A2P is approved, automatic
  text-back is enabled, commercial setup is settled, and the Stripe card is
  ready. Calls alone never start it.
- Subscription Checkout is reserved for a canceled customer restarting after
  the initial trial has already been used.
- Customers use Stripe Customer Portal from Settings to change payment
  methods, view invoices, update billing details, and cancel.
- A scheduled cancellation remains active through the paid period.
- Failed payments show a clear Manage billing action without automatically
  disabling missed-call capture.
- Customers request refunds from Relay. Authorized staff execute approved
  refunds in Stripe, never in Relay; Relay displays the result only after
  Stripe confirms it.

## Handoff

Before handoff:

1. Run `npm run verify:account -- <slug>`.
2. Run `npm run verify:launch -- <slug>`.
3. Confirm one real missed call reached the CRM.
4. Confirm the owner can sign in and understands `/leads`, `/setup`, and
   `/settings`.
5. Explain that call capture works independently from automatic texting.
6. Explain the $150 one-time fee, $99 monthly price, Stripe billing controls,
   and refund-support path.

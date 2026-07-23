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

1. Accept the request in `/ops/setup-requests`.
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

Automatic texting may still be unavailable. That does not block calls, CRM
access, or monthly billing.

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
- Monthly Checkout becomes available when call capture is `live`; A2P and the
  setup-fee state do not secretly block it.
- Customers use Stripe Customer Portal from Settings to change payment
  methods, view invoices, update billing details, and cancel.
- A scheduled cancellation remains active through the paid period.
- Failed payments show a clear Manage billing action without automatically
  disabling missed-call capture.
- Customers request refunds from Relay. Operators issue approved refunds in
  Stripe; Relay displays the result only after Stripe confirms it.

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

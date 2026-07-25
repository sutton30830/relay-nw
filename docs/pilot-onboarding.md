# Relay Pilot Onboarding

> **Current billing contract:** founding pilots receive an audited setup-fee
> waiver, add a card securely through Stripe without a charge, and receive a
> 30-day Stripe-owned trial only after automatic text-back activates.

Pilot onboarding is white-glove, but the customer experience stays simple:
Relay prepares the account, the customer enables forwarding when needed, and
the first real missed call proves the system is live.

## 1. Create the account

Apply current migrations before deploying the matching application code, then
provision the tenant:

```bash
ACCOUNT_SLUG="abc-plumbing" \
BUSINESS_NAME="ABC Plumbing" \
OWNER_PHONE_NUMBER="+15557654321" \
TWILIO_PHONE_NUMBER="+15551234567" \
INTAKE_URL="https://relay-nw.com/intake" \
OWNER_EMAIL="owner@example.com" \
CALL_MODE="forwarding" \
SMS_ENABLED="false" \
npm run provision:account
```

Create or invite the same owner email in Supabase Auth. Human access resolves
through:

```text
Supabase Auth user -> account_users -> account_id -> account data
```

## 2. Configure calls

Set the account's Twilio number webhooks:

- Voice: `https://relay-nw.vercel.app/api/twilio/voice`
- Messaging: `https://relay-nw.vercel.app/api/twilio/sms`
- Method: `POST`

For forwarding accounts, help the customer turn on conditional forwarding from
their existing business number to the Relay number. For direct accounts,
customers call the Relay number itself.

Do not use synthetic forwarding or SMS tests. Make one real missed call and
confirm that it creates exactly one account-scoped lead. A signed, newly
inserted missed call moves technical setup to `live` automatically.

## 3. Complete A2P externally

Collect registration details during the onboarding conversation and complete
the brand/campaign work in Twilio. Synchronize only the status in Relay.

Keep automatic texting off until A2P is `approved`. A2P never blocks call
capture or CRM access, and carrier/customer delay never consumes trial time.

## 4. Configure billing

- Standard customers pay the one-time $150 setup fee in Stripe; Checkout also
  retains the card with clear reuse consent.
- Founding pilots must have an audited waiver and complete Stripe's no-charge
  card setup before provisioning.
- Monthly service is $99. The initial 14-day standard or 30-day pilot trial is
  created automatically only after calls are live, A2P is approved, and
  automatic text-back is enabled.
- Calls working alone never start trial time.
- Subscription Checkout is used only to restart a canceled account after its
  initial trial has already been used.
- Customers manage payment methods, invoices, billing details, and
  cancellation in Stripe Customer Portal.
- Use Relay policy only for audited waivers or comps; never represent those as
  successful Stripe payments.

## 5. Acceptance

Use the executable [Pilot Certification Checklist](pilot-certification-checklist.md)
and retain its evidence with the account.

- `npm run verify:account -- <slug>` passes.
- `npm run verify:billing` passes for the environment.
- `npm run verify:launch -- <slug>` passes.
- A real missed call creates one lead and marks calls live.
- Voicemail recording and transcription behave visibly.
- Automatic SMS sends only when A2P is approved and the owner enabled it.
- Stripe shows the correct 14-day standard or 30-day founding-pilot trial only
  after automatic text-back activation.
- STOP suppresses future automatic SMS.
- Inbound replies and Stripe events resolve to the correct account.
- The owner can access only their account.
- Operational failures are visible in Relay Operations and alerting.

# Repeatable Onboarding Runbook

Use the **Onboarding readiness** panel in `/ops/accounts/<slug>` as the single
workflow. It derives its state from account data, signed/provider events,
Supabase Auth, Stripe, and authenticated customer confirmations. Never use the
existence of an account or Relay number as proof that the customer is live.

## Operator checklist

1. Accept the setup request in `/ops`. Confirm legal and public business names,
   owner name/email/mobile, existing published number, call mode, carrier,
   business hours, and missed-call coverage expectations in **Customer details**.
2. Review the exact missed-call SMS and voicemail greeting. The SMS must identify
   the business and preserve Relay's consent disclosure, STOP/START, HELP, and
   opt-out suppression behavior.
3. Confirm the owner accepted the Supabase Auth invite and can sign in. Configure
   the audited trial/billing path in Stripe or record an authorized comp.
4. Attach an existing Twilio number. For forwarding accounts, send the customer
   to `/setup#forwarding` and use the recorded carrier instructions.
5. Place one real call to the published business number and let it go unanswered.
   Calls are verified only when a valid Twilio signature creates a new,
   tenant-scoped missed-call lead. Synthetic or duplicate webhooks do not count.
6. Complete A2P in Twilio and use **Sync from Twilio**. This remains separate from
   call readiness. Only authoritative `approved` status permits the owner to
   enable automatic text-back. Follow the
   [post-approval activation runbook](operations/a2p-post-approval-activation.md):
   the authenticated owner must separately authorize first activation, and
   Relay must retain the resulting audit event.
7. Run a real missed-call SMS test and wait for Twilio's `delivered` callback.
   Then use an approved landline/non-SMS destination and retain Twilio error
   `30006`; do not repeatedly text an unknown customer's landline.
8. Send the **Owner notification test** in Operations. The owner confirms receipt
   from `/setup`; provider acceptance alone is not receipt.
9. Review every readiness check. When all earlier evidence is complete, ask the
   authenticated owner to explicitly approve go-live in `/setup`.
10. Run `npm run verify:account -- <slug>` and
    `npm run verify:launch -- <slug>`. Retain the output with the account handoff.

## Derived states

- **Calls not configured:** required profile or Relay-number evidence is missing.
- **Awaiting forwarding test:** profile and number exist; no signed real missed
  call has verified the route.
- **Calls verified:** signed call evidence exists; texting is not yet approved.
- **Texting registration pending:** calls are verified and Twilio is reviewing A2P.
- **Texting approved:** Twilio approved A2P; delivery evidence is still missing.
- **SMS delivery verified:** Twilio confirmed delivery; remaining launch checks
  may still be incomplete.
- **Ready for production:** every required check, including owner approval, is
  complete.
- **Blocked:** the screen names Relay, customer, carrier, or Stripe and shows the
  recorded reason. Resolve that owner/reason before continuing.

## Invalidation and safety

- Changing routing details resets call verification to setup/forwarding state.
- Changing SMS wording or the Relay number clears messaging test evidence and
  customer approval.
- Changing the owner email clears notification evidence and customer approval.
- Any profile edit clears prior go-live approval. The owner must approve the
  resulting current configuration, not a superseded one.
- Operators can resolve data and blockers; they cannot manually select a
  readiness state, approve A2P, invent Stripe truth, or approve on the customer's
  behalf.
- `sms_enabled=true` without an authenticated owner's
  `texting.activation_approved` event is not launch-ready.

## Release order

The evidence table and new account-settings fields are introduced by
`docs/migrations/2026-08-05-repeatable-onboarding.sql`. Apply the migration in a
controlled maintenance window before deploying the matching application commit.
This runbook does not authorize applying it to production.

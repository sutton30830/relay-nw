# Stripe Authority Migration

Status: Phase 1 delayed-trial migration implemented July 23, 2026. The current
contract is `docs/strategy/BILLING-OPERATIONS-SIMPLIFICATION.md`.

## Boundary

Stripe owns customer, payment-method, setup-fee payment, subscription, invoice, retry, refund, dispute, and cancellation truth. Relay owns technical readiness plus the explicit commercial exceptions `setup_fee_waived` and `comped`.

`accounts.billing_status` remains a synchronized Stripe-facing snapshot during the rollout. `accounts.billing_policy` is the authority for Relay-granted exceptions. Existing `billing_status = 'comped'` and `setup_fee_status = 'waived'` values remain temporary compatibility shadows and must not be interpreted as Stripe events.

## Migration

Apply `docs/migrations/2026-07-22-stripe-authority.sql`, followed by
`docs/migrations/2026-07-23-phase1-delayed-stripe-trials.sql`.

The combined migration:

1. Adds `billing_policy` with `standard`, `setup_fee_waived`, and `comped`.
2. Adds `billing_policy_updated_at`.
3. Backfills policy from legacy `comped` and `waived` values.
4. Adds the commercial offer, Stripe SetupIntent, Checkout-session, and
   default-payment-method display fields used by delayed activation.
5. Adds the audited `set_account_commercial_offer` operation.
6. Repairs only the documented sample account's stale test-mode links while
   preserving Stripe event history.
7. Preserves legacy columns and values for a rolling-deploy compatibility window.

Fresh environments receive the same schema through `supabase.sql`.

## Deployment order

1. Export or snapshot the affected `accounts` billing columns.
2. Apply the additive migration.
3. Verify every legacy comped/waived row has the expected `billing_policy`.
4. Deploy the Phase 1 application.
5. Run `npm run verify:billing`.
6. Reconcile representative standard, comped, waived, active, past-due, canceling, refunded, and disputed accounts.
7. Keep legacy status values until the later cleanup phase has observed production stability.

New policy writes require the migration and should be deployed after it.

## Checkout, activation, and Portal

- Standard setup Checkout charges `$150` and asks Stripe to retain the card
  with explicit reuse disclosure.
- Founding-pilot Checkout runs in `setup` mode, charges nothing, and saves the
  card in Stripe after an audited setup-fee waiver.
- Call capture alone never creates a subscription.
- The initial subscription is created idempotently only when call capture is
  live, A2P is approved, automatic text-back is enabled, the commercial setup
  is settled, and Stripe has a default payment method.
- Stripe receives `trial_period_days=14` for standard customers or `30` for
  founding pilots. Missing-payment-method trial-end behavior is `cancel`.
- Subscription Checkout is an authenticated restart path after the initial
  free trial has already been used; it does not grant another trial.
- Customer Portal owns payment-method changes, invoices, billing details, and cancellation.
- Portal cancellation should be configured for end-of-period cancellation and cancellation-reason collection.
- Relay keeps call capture running through a scheduled cancellation's paid period.

## Webhook contract

The configured Stripe endpoint must include:

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.updated`
- `payment_method.attached`
- `payment_method.detached`
- `setup_intent.succeeded`
- `setup_intent.setup_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.payment_action_required`
- `charge.refunded`
- `refund.created`
- `refund.updated`
- `refund.failed`
- `charge.dispute.created`
- `charge.dispute.closed`
- `customer.deleted`

All events are signature-verified, claimed idempotently by Stripe event ID, resolved to an account without guessing, and recorded as processed, ignored, or failed.

Stripe subscription events update billing state only. They do not advance technical onboarding, clear onboarding deadlines, or enable texting.

## Refunds

Customers request refunds from Relay. Authorized operators initiate the refund in Stripe. Relay shows the result only after webhook processing or explicit Stripe reconciliation confirms the PaymentIntent state.

`refund.created`, `refund.updated`, and `refund.failed` are handled in addition to `charge.refunded`. A failed refund leaves the setup-fee payment state derived from the current Stripe PaymentIntent instead of inventing a refunded state.

## Deferred cleanup

After production verification:

- Stop writing legacy `billing_status = 'comped'`.
- Stop writing legacy `setup_fee_status = 'waived'`.
- Remove obsolete local payment-method compatibility columns after Stripe
  default-payment-method synchronization has observed production stability.
- Narrow the old status constraints.
- Remove compatibility fallbacks.

These are deliberately deferred because they are destructive or require simultaneous changes across operator UI, historical rows, and activation workflows.

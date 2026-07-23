# Stripe Authority Migration

Status: Phase 1 implementation and deployment design.

## Boundary

Stripe owns customer, payment-method, setup-fee payment, subscription, invoice, retry, refund, dispute, and cancellation truth. Relay owns technical readiness plus the explicit commercial exceptions `setup_fee_waived` and `comped`.

`accounts.billing_status` remains a synchronized Stripe-facing snapshot during the rollout. `accounts.billing_policy` is the authority for Relay-granted exceptions. Existing `billing_status = 'comped'` and `setup_fee_status = 'waived'` values remain temporary compatibility shadows and must not be interpreted as Stripe events.

## Migration

Apply `docs/migrations/2026-07-22-stripe-authority.sql`.

The migration:

1. Adds `billing_policy` with `standard`, `setup_fee_waived`, and `comped`.
2. Adds `billing_policy_updated_at`.
3. Backfills policy from legacy `comped` and `waived` values.
4. Preserves legacy columns and values for a rolling-deploy compatibility window.
5. Makes no destructive changes.

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

## Checkout and Portal

- Subscription Checkout is allowed when real call capture is ready.
- A2P and setup-fee status are not Checkout gates.
- Customer Portal owns payment-method changes, invoices, billing details, and cancellation.
- Portal cancellation should be configured for end-of-period cancellation and cancellation-reason collection.
- Relay keeps call capture running through a scheduled cancellation's paid period.

## Webhook contract

The configured Stripe endpoint must include:

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
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
- Remove local `stripe_payment_method_id` after saved-card operator activation is replaced by Stripe-hosted flows.
- Retire app-managed trial state and trial cron behavior, or move trials fully into Stripe.
- Narrow the old status constraints.
- Remove compatibility fallbacks.

These are deliberately deferred because they are destructive or require simultaneous changes across operator UI, historical rows, and activation workflows.

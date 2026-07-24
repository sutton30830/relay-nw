# Billing and Operations Simplification

Status: approved Phase 0 target architecture. Runtime implementation begins in Phase 1.

## Outcome

Relay Operations is one action queue, not a second CRM or a hand-maintained lifecycle. An operator should be able to answer five questions without opening diagnostics:

1. Are calls ready?
2. Is automatic texting ready?
3. What does Stripe say?
4. Who is blocking progress?
5. What is the one next action?

## Commercial offers

| Offer | Setup fee | Stripe-owned trial | Monthly price | Trial starts |
|---|---:|---:|---:|---|
| Standard | $150 required | 14 days | $99 | Automatic text-back activation |
| Founding pilot | $150 explicitly waived | 30 days | $99 | Automatic text-back activation |

A founding-pilot waiver is an audited Relay policy decision. It is not a payment, refund, credit, or active subscription.

The $99 product is automatic missed-call text-back plus the shared conversation inbox and booked-work visibility. Call capture can work during setup, but it does not start the monthly trial.

## Independent facts

| Domain | Minimal meaning | Authority |
|---|---|---|
| Calls | Setting up, waiting for forwarding, live, paused, closed | Relay technical evidence |
| Texting | Preparing, carrier review, approved, issue | Twilio/carriers |
| Billing | Setup due, card ready, trial, active, attention, canceled | Stripe |
| Blocker | None, Relay, customer, carrier | Relay operator |

There is no manually selected overall lifecycle. Queue grouping and next action are derived from these facts.

## Activation invariant

A monthly trial is eligible to start only when all of the following are true:

- a signed real missed call has made technical setup `live`;
- A2P is `approved`;
- automatic texting is enabled;
- required commercial consent and payment-method setup are complete in Stripe;
- the account is not paused or closed;
- `blocked_by` is `none`;
- Stripe has no conflicting active, trialing, incomplete, or past-due subscription.

Starting the trial is an idempotent Stripe operation. Relay does not first write `trialing` and hope Stripe agrees.

## Delay policy

| Blocked by | Trial treatment | Operator responsibility |
|---|---|---|
| Relay | Does not start | Finish Relay setup work |
| Customer | Does not start | Request one specific item and record when waiting began |
| Carrier | Does not start | Monitor Twilio/carrier review |
| None | May start when all activation invariants pass | Perform the derived activation action |

Phase 0 introduces no deadline automation. A later phase may show stale blocker age, but it must not silently charge, close, or refund an account.

## Operations information architecture

Primary navigation:

- **Work queue:** needs attention, onboarding, running, paused/closed.
- **Accounts:** searchable directory, not a second pipeline.
- **Team:** operator access.

The account workspace presents:

1. Status header for Calls, Texting, Billing, and Blocker.
2. One derived primary action.
3. One setup card.
4. One billing card.
5. Collapsed customer details.
6. Collapsed diagnostics.

## Control boundary

- Support can read accounts and diagnostics.
- Operators can perform setup work, update A2P operational status, and own blockers.
- Super admins can approve audited waivers, comps, pauses, closures, and reopenings.
- Stripe owns payment methods, invoices, refunds, retries, disputes, and cancellation.

Operators never manually write favorable Stripe states. External failures remain visible and leave local state unchanged until Stripe confirms the result.

## Phase 0 compatibility boundary

Production currently allows subscription Checkout after technical call capture becomes `live`. Phase 0 deliberately does not change that runtime path. The pure target helpers and tests define the replacement behavior; Phase 1 must migrate the Stripe flow and runtime atomically before the compatibility rule is removed.

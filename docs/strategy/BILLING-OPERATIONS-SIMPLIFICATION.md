# Billing and Operations Simplification

Status: Phase 3 single Work queue implemented July 23, 2026. Stripe-owned
delayed trials, blocker ownership, and the derived Work queue are live.
Operations navigation is Work queue, Accounts, and Team; old Customers and
Requests links redirect temporarily.

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
| Calls | Setting up, waiting for forwarding, ready, paused | Signed real-call evidence and explicit Relay holds |
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
- calls are not paused;
- `ops_blocked_by` is `none`;
- Stripe has no conflicting active, trialing, incomplete, or past-due subscription.

Starting the trial is an idempotent Stripe operation. Relay does not first write `trialing` and hope Stripe agrees.

## Delay policy

| Blocked by | Trial treatment | Operator responsibility |
|---|---|---|
| Relay | Does not start | Finish Relay setup work |
| Customer | Does not start | Request one specific item and record when waiting began |
| Carrier | Does not start | Monitor Twilio/carrier review |
| None | May start when all activation invariants pass | Perform the derived activation action |

Phase 2 shows blocker age for operator context. Age does not silently charge,
pause, cancel, close, or refund an account.

## Operations information architecture

Primary navigation:

- **Work queue:** needs attention, onboarding, running, paused or closed.
  New setup requests appear at the top of Onboarding.
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
- Operators can perform setup work, synchronize A2P status from Twilio, own
  blockers, and set explicit call holds. They cannot select A2P approval or
  call readiness.
- Super admins can approve audited waivers and comps. Authorized operators can
  record blockers and explicit call holds.
- Stripe owns payment methods, invoices, refunds, retries, disputes, and cancellation.

Operators never manually write favorable Stripe states. External failures remain visible and leave local state unchanged until Stripe confirms the result.

## Phase 3 runtime boundary

Production now collects the standard setup payment or founding-pilot card
through Stripe, then creates the initial Stripe-owned trial only after full
automatic text-back activation. Subscription Checkout is reserved for a
customer restarting after the initial trial has already been used.

Operations stores only blocker owner, blocker reason, and blocker start time.
The queue group, four status labels, blocker age, and one next action are
derived in application code and covered exhaustively. Trial activation reads
the blocker atomically with the independent technical, A2P, SMS, and commercial
facts. A non-`none` blocker prevents Stripe activation without consuming trial
time.

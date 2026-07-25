# Relay Customer Experience Contract

Status: Phase 1 billing contract implemented July 23, 2026. Later Operations
and customer-experience phases must preserve these invariants.

## Product promise

Relay's paid promise is not call logging by itself. Relay automatically responds to missed callers, captures the resulting conversation in one inbox, and makes recovered and booked opportunities visible. The customer should always understand what Relay is doing, what action is required, what they will pay, and when they will be charged.

The customer-facing journey has two phases:

1. **Get calls live.** Relay configures the account, the customer enables forwarding when necessary, and the first valid real missed call reaching the CRM completes this phase.
2. **Enable texting.** Relay manages A2P registration outside the customer workflow. Approval makes automatic texting available; the owner still chooses whether to enable it.

Calls and A2P setup happen in parallel. A real missed call can prove calls ready while carrier review continues. Billing is a separate commercial relationship: technical call readiness does not start monthly billing, and carrier or customer delay does not consume trial time.

## One owner per domain

| Domain | Authority | Relay responsibility |
|---|---|---|
| Technical setup | Relay | Account, Twilio routing, forwarding guidance, CRM readiness, first-call proof |
| A2P registration | Twilio/carriers | Submit externally, synchronize status, gate automatic texting |
| Payments and subscriptions | Stripe | Checkout, payment methods, subscriptions, trials, invoices, retries, refunds, disputes, cancellation |
| Commercial exceptions | Relay | Setup-fee waiver, comped service, support-approved exceptions |
| Operational blocker | Relay | Record whether Relay, the customer, the carrier, or nobody currently blocks progress |

No domain may silently rewrite another domain's state.

## Target states

### Technical setup

| State | Meaning | Customer action |
|---|---|---|
| `setting_up` | Relay is preparing the account | None |
| `waiting_for_forwarding` | Relay is ready but forwarding must be enabled | Follow one carrier-specific instruction or ask Relay for help |
| `live` | A valid real missed call reached the CRM | None |
| `paused` | Relay intentionally paused service | Contact Relay if unexpected |
| `closed` | The account was closed | None |

The first valid, newly inserted missed-call lead may transition `setting_up` or `waiting_for_forwarding` to `live`. A duplicate event, unsigned webhook, or call against a paused, closed, or already-live account cannot perform this transition.

### A2P registration

`not_started`, `in_progress`, `approved`, `needs_attention`, `rejected`, and `paused` are messaging-compliance states only.

- A2P never blocks call capture or CRM access.
- Only `approved` permits automatic texting to be enabled.
- Approval never starts a trial by itself or enables texting without recorded
  commercial consent. Trial creation follows the full automatic text-back
  activation event and is idempotent.
- Registration work is operator-driven and primarily completed in Twilio.

### Operational blocker

Operations records one blocker owner: `none`, `relay`, `customer`, or `carrier`.

- The blocker explains responsibility; it is not another customer lifecycle.
- A customer or carrier blocker cannot start or consume monthly trial time.
- A non-`none` blocker carries a short reason and the time waiting began.
- The next operator action is derived from calls, texting, Stripe, and blocker state; it is not manually invented.

### Billing policy

Relay policy is one of `standard`, `setup_fee_waived`, or `comped`.

- A waiver is not represented as a successful Stripe payment.
- A founding pilot receives an audited setup-fee waiver; the setup fee is never labeled paid or refunded.
- A comp is not represented as an active Stripe subscription.
- Policy exceptions require an operator audit event.

### Stripe billing state

Stripe is authoritative for payment methods, setup-fee payments, subscriptions, trials, invoices, refunds, disputes, chargebacks, payment failures, retries, and cancellations. Relay stores identifiers and a synchronized display snapshot; it does not invent a more favorable state than Stripe reports. Operators cannot manually assert `paid`, `refunded`, `trialing`, `active`, or `canceled`.

## Billing promises shown before payment

- A standard account pays **$150 once** for setup.
- A founding pilot receives an explicitly audited setup-fee waiver.
- Service costs **$99 per month** unless the account is explicitly comped.
- The customer sees what is charged now and what will be charged later before entering Checkout.
- A standard customer's Stripe-owned trial is **14 days**.
- A founding pilot's Stripe-owned trial is **30 days**.
- A trial may begin only when call capture is `live`, A2P is `approved`, automatic text-back is enabled, commercial consent is recorded, and nobody remains blocked.
- Call capture by itself never starts the monthly trial.
- Carrier review and customer delay never consume trial time.
- Payment methods, invoices, billing details, and cancellation are managed through Stripe Customer Portal.

## Cancellation, failed payments, and refunds

- Customer-requested cancellation is handled through Stripe Customer Portal.
- A scheduled cancellation keeps service through the paid period and shows the end date.
- A payment failure produces a clear update-payment action through Stripe.
- Call capture is not automatically interrupted merely because a payment enters `past_due`; suspension requires an explicit, separately approved grace-period policy.
- Customers request refunds from Relay. Authorized staff execute them in Stripe. Relay changes the displayed refund state only after Stripe confirms it by webhook or reconciliation.

The exact grace-period duration and post-period suspension automation are deliberately deferred. They must be approved as a business policy before implementation; the application must not infer them.

## Customer-interface rules

- Show one primary action at a time.
- Show the calls, texting, and billing states independently.
- Never ask for information already collected at intake.
- Preselect the carrier/provider when known.
- Keep technical diagnostics, lifecycle transitions, and raw payment state out of customer setup.
- Do not expose synthetic forwarding tests, SMS tests, A2P questionnaires, or internal readiness scoring.
- Always offer Relay-assisted forwarding help.
- Billing appears as a concise summary with one **Manage billing** action, separate from technical setup.

## Implementation invariants

1. Technical readiness is derived without A2P or billing inputs.
2. A2P approval gates texting only.
3. A monthly trial requires active automatic text-back, recorded commercial consent, and no operational blocker.
4. Call readiness alone cannot start monthly billing.
5. Standard and founding-pilot trial lengths are 14 and 30 days respectively.
6. Stripe webhooks and reconciliation own payment, trial, and subscription truth.
7. Relay policy owns waivers and comps without falsifying Stripe state.
8. Blocker ownership explains delay without rewriting technical, A2P, or Stripe state.
9. The setup fee, subscription, A2P, blocker, and technical service state remain independently observable.
10. Existing production data is migrated before old state handling is removed.
11. Destructive cleanup follows a verified deprecation window.

## Phase boundaries

- **Phase 0:** approve this contract and make its independence rules executable.
- **Phase 1:** implement Stripe-owned delayed trials and correct billing truth.
- **Phase 2 (complete):** add audited operational blocker ownership and derive
  Calls, Texting, Billing, queue grouping, blocker age, and one next action
  without another overall lifecycle.
- **Phase 3:** rebuild Operations as one work queue.
- **Phase 4A (complete):** secure operator controls and external-state
  authority.
- **Phase 4B (complete):** rebuild the account workspace as one status header,
  one derived primary action, one setup card, one billing card, collapsed
  customer details, and collapsed diagnostics.
- **Phase 5:** rebuild customer-facing setup and billing presentation.
- **Phase 6:** remove obsolete surfaces.
- **Phase 7:** complete security, billing, and pilot certification.

No later phase is complete if it violates an invariant in this contract.

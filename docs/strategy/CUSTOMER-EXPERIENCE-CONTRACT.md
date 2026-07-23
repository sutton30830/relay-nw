# Relay Customer Experience Contract

Status: approved Phase 0 target contract. This document defines the behavior later implementation phases must preserve. It does not claim that the current application already follows the contract.

## Product promise

Relay asks the customer for business details, helps them forward missed calls once, and handles the rest. The customer should always understand what Relay is doing, what action is required, what they will pay, and when they will be charged.

The customer-facing journey has two phases:

1. **Get calls live.** Relay configures the account, the customer enables forwarding when necessary, and the first valid real missed call reaching the CRM completes this phase.
2. **Enable texting.** Relay manages A2P registration outside the customer workflow. Approval makes automatic texting available; the owner still chooses whether to enable it.

Billing is a separate commercial relationship. It must be transparent, but it is not a technical onboarding phase.

## One owner per domain

| Domain | Authority | Relay responsibility |
|---|---|---|
| Technical setup | Relay | Account, Twilio routing, forwarding guidance, CRM readiness, first-call proof |
| A2P registration | Twilio/carriers | Submit externally, synchronize status, gate automatic texting |
| Payments and subscriptions | Stripe | Checkout, payment methods, invoices, retries, refunds, disputes, cancellation |
| Commercial exceptions | Relay | Setup-fee waiver, comped service, support-approved exceptions |

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

- A2P never blocks call capture, CRM access, or monthly billing.
- Only `approved` permits automatic texting to be enabled.
- Approval never enables texting without the owner's choice.
- Registration work is operator-driven and primarily completed in Twilio.

### Billing policy

Relay policy is one of `standard`, `setup_fee_waived`, or `comped`.

- A waiver is not represented as a successful Stripe payment.
- A comp is not represented as an active Stripe subscription.
- Policy exceptions require an operator audit event.

### Stripe billing state

Stripe is authoritative for payment methods, setup-fee payments, subscriptions, invoices, refunds, disputes, chargebacks, payment failures, and cancellations. Relay stores identifiers and a synchronized display snapshot; it does not invent a more favorable state than Stripe reports.

## Billing promises shown before payment

- Setup costs **$150 once** unless Relay explicitly waives it.
- Service costs **$99 per month** unless the account is explicitly comped.
- The customer sees what is charged now and what will be charged later before entering Checkout.
- Monthly billing may begin only after technical setup is `live`.
- A2P approval and setup-fee status do not act as hidden technical or monthly-billing gates.
- Payment methods, invoices, billing details, and cancellation are managed through Stripe Customer Portal.

## Cancellation, failed payments, and refunds

- Customer-requested cancellation is handled through Stripe Customer Portal.
- A scheduled cancellation keeps service through the paid period and shows the end date.
- A payment failure produces a clear update-payment action through Stripe.
- Call capture is not automatically interrupted merely because a payment enters `past_due`; suspension requires an explicit, separately approved grace-period policy.
- Customers request refunds from Relay. Operators approve them and initiate them in Stripe. Relay changes the displayed refund state only after Stripe confirms it by webhook or reconciliation.

The exact grace-period duration and post-period suspension automation are deliberately deferred. They must be approved as a business policy before implementation; the application must not infer them.

## Customer-interface rules

- Show one primary action at a time.
- Never ask for information already collected at intake.
- Preselect the carrier/provider when known.
- Keep technical diagnostics, lifecycle transitions, and raw payment state out of customer setup.
- Do not expose synthetic forwarding tests, SMS tests, A2P questionnaires, or internal readiness scoring.
- Always offer Relay-assisted forwarding help.
- Billing appears as a concise summary with one **Manage billing** action, separate from technical setup.

## Implementation invariants

1. Technical readiness is derived without A2P or billing inputs.
2. A2P approval gates texting only.
3. Monthly billing eligibility is derived from technical `live` status only.
4. Stripe webhooks and reconciliation own payment truth.
5. Relay policy owns waivers and comps without falsifying Stripe state.
6. The setup fee, subscription, and technical service state remain independently observable.
7. Existing production data is migrated before old state handling is removed.
8. Destructive cleanup follows a verified deprecation window.

## Phase boundaries

- **Phase 0:** approve this contract and make its independence rules executable.
- **Phase 1:** make Stripe the billing authority and simplify local billing state.
- **Phase 2:** simplify technical onboarding and first-call go-live.
- **Phase 3:** rebuild customer-facing setup and billing presentation.
- **Phase 4:** simplify operator workflows and externalize A2P work.
- **Phase 5:** remove obsolete systems, migrate remaining data, and verify the complete journey.

No later phase is complete if it violates an invariant in this contract.

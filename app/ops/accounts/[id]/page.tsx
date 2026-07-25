import Link from "next/link";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { Icon } from "@/components/icon";
import { requirePlatformOperator } from "@/lib/auth";
import { canApplyOperatorBillingOverride, isSetupFeeSettled } from "@/lib/billing";
import {
  deriveOpsState,
  type OpsCallsState,
} from "@/lib/ops-state";
import { stripeDashboardPaymentUrl } from "@/lib/stripe-billing";
import {
  getOpsAccountBySlug,
  getOpsBillingAccountBySlug,
  getRecentStripeEventsForAccount,
  getRecentWebhookEventsForAccount,
  getCarrierProfile,
  getAccountConfigByAccountId,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

// One page per customer. Everything an operator does to an account happens
// here, in reading order: where they are → the next action → the two money
// moments (kickoff, monthly) → setup progress → facts. Raw technical events
// (Stripe webhook processing, call/text system events) stay collapsed at the
// bottom under Diagnostics so the jargon never competes with the decisions.

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function kickoffNotice(status: string | undefined, foundingPilot: boolean) {
  if (!status) return null;
  if (status === "payment_link_sent") {
    return foundingPilot
      ? "Secure no-charge Stripe card link emailed to the founding pilot."
      : "Secure $150 setup-payment link emailed to the customer.";
  }
  if (status === "failed") return "Kickoff action failed. No billing state was changed unless shown above.";
  return "Kickoff action received.";
}

function billingActionNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "comp") return "Billing is now comped.";
  if (status === "uncomp") return "Comp removed. Stripe billing details were left unchanged.";
  if (status === "waive_setup_fee") return "The $150 setup fee was waived and recorded.";
  if (status === "require_setup_fee") return "The $150 setup fee is required.";
  if (status === "reason_required") return "Add a meaningful reason (at least five characters) before changing billing policy.";
  if (status === "confirmation_required") return "Confirm this commercial exception before applying it.";
  if (status === "forbidden") return "Only a super admin can approve a commercial exception.";
  if (status === "reconciled") return "Billing state refreshed from Stripe.";
  if (status === "reconcile_failed") return "Stripe reconciliation failed. Check Diagnostics before retrying.";
  if (status === "setup_fee_already_paid") return "Not changed. A paid setup fee cannot be overwritten.";
  if (status === "override_blocked") return "Not changed. Stripe has a live subscription, so Stripe remains the source of truth.";
  if (status === "setup_incomplete") return "Trial activation is waiting for full automatic text-back readiness.";
  if (status === "past_due") return "Monthly billing is past due; use the Billing Portal instead of starting another subscription.";
  if (status === "already_active") return "An active subscription already exists.";
  if (status === "subscription_incomplete") return "Stripe has an incomplete subscription; resolve it before retrying.";
  if (status === "checkout_failed") return "Stripe Checkout could not be started. Check the billing events below.";
  if (status === "trial_started") return "Stripe started the eligible free trial.";
  if (status === "trial_already_started") return "Stripe already has the account's trial or subscription. Relay synchronized it.";
  if (status === "setup_fee_required") return "The setup fee must be settled in Stripe before trial activation.";
  if (status === "payment_method_required") return "Stripe has not confirmed a reusable payment method yet.";
  if (status === "activation_not_eligible") return "Trial not started: calls, approved A2P, automatic text-back, an unpaused account, and no blocker must all be ready.";
  if (status === "subscription_conflict") return "Stripe already has another active or incomplete subscription for this customer.";
  if (status === "restart_required") return "This account already used its initial trial. Restart through Stripe Checkout.";
  if (status === "account_comped") return "No Stripe trial was started because Relay has explicitly comped this account.";
  if (status === "activation_failed") return "Stripe trial activation failed visibly. No favorable billing state was created locally.";
  if (status === "save_failed") return "Billing change failed. Check logs before trying again.";
  if (status === "invalid_action") return "Choose a valid billing action.";
  return null;
}

function billingActionSucceeded(status: string | undefined) {
  return status === "comp" || status === "uncomp" || status === "waive_setup_fee" || status === "require_setup_fee" ||
    status === "reconciled" || status === "trial_started" || status === "trial_already_started";
}

function setupStageCopy(calls: OpsCallsState) {
  if (calls === "setting_up") return "Relay is getting call capture ready.";
  if (calls === "waiting_for_forwarding") return "Waiting for customer forwarding.";
  if (calls === "ready") return "Call capture is ready.";
  return "Calls are on an explicit hold.";
}

function blockerNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "saved") return "Blocker ownership updated and audited.";
  if (status === "reason_required") return "Add a blocker reason between 5 and 240 characters.";
  if (status === "invalid_owner") return "Choose Relay, customer, carrier, or none.";
  if (status === "save_failed") return "The blocker was not changed. Check logs before retrying.";
  return "Blocker update was not completed.";
}

function carrierNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "invalid_ids") return "Enter the MG Messaging Service SID and QE Campaign SID from Twilio.";
  if (status === "sync_failed") return "Twilio status could not be read. No A2P state was changed.";
  if (status === "save_failed") return "Twilio was read, but Relay could not save the compliance result. Trial was not started.";
  if (status === "unknown_status") return "Twilio returned an unfamiliar campaign status. No A2P state was changed.";
  return `Twilio campaign status synchronized: ${status.replaceAll("_", " ")}.`;
}

function accountControlNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "saved") return "Account control updated and audited.";
  if (status === "paid_service_requires_super_admin") return "Paid service can be paused only by a super admin using the confirmed paid-service action.";
  if (status === "not_paid_service") return "This account has no active or incomplete Stripe subscription requiring a paid-service pause.";
  if (status === "account_requires_reopen") return "A closed or service-paused account must be reopened by a super admin.";
  if (status === "invalid_state") return "That action does not apply to the account's current operational state.";
  if (status === "reason_required") return "Add a meaningful reason for this sensitive account action.";
  if (status === "confirmation_required") return "Confirm the sensitive account action before applying it.";
  if (status === "invalid") return "Choose a valid account control.";
  if (status === "account_not_found") return "The account could not be resolved.";
  return "The account control failed visibly. No Stripe state was changed.";
}

export default async function OpsAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    kickoff?: string;
    billing_action?: string;
    carrier?: string;
    number?: string;
    profile?: string;
    calls?: string;
    blocker?: string;
  }>;
}) {
  const operator = await requirePlatformOperator();
  const { id } = await params;
  const notices = await searchParams;

  const [summary, billing] = await Promise.all([
    getOpsAccountBySlug(id),
    getOpsBillingAccountBySlug(id),
  ]);

  if (!summary || !billing) {
    return (
      <main className="leads-view">
        <section className="leads-shell">
          <OpsHeader currentPage="accounts" operatorEmail={operator.email} />
          <div className="panel setup-panel ops-account-empty">
            <p className="t-eyebrow">Account not found</p>
            <h1 className="t-display">Choose another account.</h1>
            <p className="setup-copy">The requested account does not exist or is no longer available.</p>
            <Link className="btn btn-secondary" href="/ops">Back to Operations</Link>
          </div>
        </section>
      </main>
    );
  }

  const isComped = billing.billingPolicy === "comped";
  const isFoundingPilot = billing.commercialOffer === "founding_pilot";
  const setupFeeWaived = billing.billingPolicy === "setup_fee_waived" || isFoundingPilot;
  const effectiveBillingStatus = isComped ? "comped" : billing.billingStatus;

  const opsState = deriveOpsState({
    technicalStatus: summary.technicalStatus,
    a2pStatus: summary.a2pStatus,
    smsEnabled: summary.smsEnabled,
    billingStatus: effectiveBillingStatus,
    billingPolicy: billing.billingPolicy,
    stripeSubscriptionStatus: billing.stripeSubscriptionStatus,
    setupFeeStatus: billing.setupFeeStatus,
    stripeDefaultPaymentMethodId: billing.stripeDefaultPaymentMethodId,
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    blockedBy: summary.opsBlockedBy,
    blockerNote: summary.opsBlockerNote,
    blockedSince: summary.opsBlockedSince,
  });

  const [stripeEvents, systemEvents, carrierProfile, runtime] = await Promise.all([
    getRecentStripeEventsForAccount(billing.accountId, 25),
    getRecentWebhookEventsForAccount(billing.accountId, 25),
    getCarrierProfile(billing.accountId),
    getAccountConfigByAccountId(billing.accountId),
  ]);
  const failedCount = stripeEvents.filter((event) => event.processing_status === "failed").length;

  const canApplyOverride = canApplyOperatorBillingOverride(billing);
  // Kickoff state, spelled out before any buttons.
  const kickoffSettled = isSetupFeeSettled(
    billing.setupFeeStatus,
    billing.firstPaidAt,
    billing.billingPolicy,
  );
  const kickoffCollectible = !kickoffSettled && (billing.setupFeeStatus === "due" || billing.setupFeeStatus === "refunded" ||
    billing.setupFeeStatus === "charged_back");
  const pilotCardNeeded =
    isFoundingPilot &&
    !isComped &&
    !billing.stripeDefaultPaymentMethodId &&
    effectiveBillingStatus !== "active" &&
    effectiveBillingStatus !== "trialing";
  const kickoffState = isComped
    ? "Comped"
    : setupFeeWaived
      ? "Waived by policy"
      : billing.setupFeeStatus === "paid"
    ? "Paid"
    : billing.setupFeeStatus === "waived"
      ? "Waived"
      : billing.setupFeeStatus === "partially_refunded"
        ? "Partially refunded"
        : billing.setupFeeStatus === "refunded"
          ? "Refunded"
          : billing.setupFeeStatus === "disputed"
            ? "Disputed"
            : billing.setupFeeStatus === "charged_back"
              ? "Charged back"
      : billing.firstPaidAt
        ? "Settled through prior activation"
        : "Due";

  // Monthly state, spelled out before any buttons.
  const monthlyState =
    effectiveBillingStatus === "active"
      ? `Active — $99/month${billing.currentPeriodEnd ? `, renews ${formatDate(billing.currentPeriodEnd)}` : ""}${billing.cancelAtPeriodEnd ? " (cancels at period end)" : ""}`
      : effectiveBillingStatus === "trialing"
        ? `Trial${billing.trialEndsAt ? ` — ends ${formatDate(billing.trialEndsAt)}` : ""}`
        : effectiveBillingStatus === "comped"
          ? "Comped — Relay is intentionally not charging"
          : effectiveBillingStatus === "past_due"
            ? "Past due — payment failed"
            : effectiveBillingStatus === "canceled"
              ? "Canceled"
              : "Not started";
  const monthlyTone = effectiveBillingStatus === "past_due" ? "warn" : "neutral";
  const stripePaymentUrl = billing.setupFeePaymentIntentId
    ? stripeDashboardPaymentUrl(billing.setupFeePaymentIntentId)
    : null;
  const kickoffMessage = kickoffNotice(notices.kickoff, isFoundingPilot);
  const billingMessage = billingActionNotice(notices.billing_action);
  const blockerMessage = blockerNotice(notices.blocker);
  const accountControlMessage = accountControlNotice(notices.calls);
  const queuePillTone =
    opsState.queueGroup === "running"
      ? "booked"
      : opsState.queueGroup === "onboarding"
        ? "new"
        : "contacted";
  return (
    <main className="leads-view">
      <section className="leads-shell">
        <OpsHeader businessName={summary.businessName} currentPage="accounts" operatorEmail={operator.email} />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Customer</p>
            <h1 className="t-display">{summary.businessName}</h1>
            <p className="leads-subtitle">
              <span className={`lead-card__status-pill lead-card__status-pill--${queuePillTone}`}>{opsState.queueLabel}</span>
              {" "}· {summary.ownerEmail ?? "Owner not set"} · {summary.accountSlug}
            </p>
          </div>
          <div className="lead-actions">
            <Link className="btn btn-secondary btn-sm" href="/ops">
              <Icon name="arrowLeft" size={14} /> Operations queue
            </Link>
          </div>
        </div>

        <div className="settings-notice" role="status">
          You are signed in as operator <strong>{operator.email}</strong> and managing the separate customer account for <strong>{summary.ownerEmail ?? "an owner whose email is not set"}</strong>. Operator changes apply only to {summary.businessName}.
        </div>

        <section className="panel setup-panel" aria-label="Independent account statuses">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Current status</p>
            <h2>Four facts, no invented lifecycle.</h2>
          </div>
          <dl className="webhook-event__meta">
            <div><dt>Calls</dt><dd>{opsState.labels.calls}</dd></div>
            <div><dt>Texting</dt><dd>{opsState.labels.texting}</dd></div>
            <div><dt>Billing</dt><dd>{opsState.labels.billing}</dd></div>
            <div>
              <dt>Blocked by</dt>
              <dd>
                {opsState.labels.blocker}
                {opsState.blockedAgeDays !== null ? ` · ${opsState.blockedAgeDays}d` : ""}
              </dd>
            </div>
          </dl>
        </section>

        {/* The one thing to do next. */}
        <section className="readiness readiness--testing ops-next" aria-label="Next operator action">
          <div className="readiness__main">
            <span className="readiness__badge"><span className="readiness__dot" aria-hidden="true" />Derived next action</span>
            <h2 className="readiness__headline">{opsState.nextAction.label}</h2>
            <p className="readiness__summary">{opsState.nextAction.detail}</p>
          </div>
        </section>

        <section className="panel setup-panel" aria-label="Operations blocker">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Blocker ownership</p>
            <h2>
              {opsState.blockedBy === "none"
                ? "Nobody is recorded as blocking progress."
                : `${opsState.labels.blocker} owns the current blocker.`}
            </h2>
            <p className="setup-copy">
              {opsState.blockerNote ??
                "Blocker ownership explains responsibility without changing Calls, Texting, or Stripe."}
            </p>
          </div>
          {blockerMessage ? (
            <div className={notices.blocker === "saved" ? "settings-notice" : "intake-error settings-notice"} role="status">
              {blockerMessage}
            </div>
          ) : null}
          {operator.role !== "support" ? (
            <form action="/api/ops/blocker" method="post" className="setup-panel__action ops-form">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <label className="form-field">
                <span className="t-eyebrow form-field__label">Blocked by</span>
                <select className="field" name="blocked_by" defaultValue={opsState.blockedBy}>
                  <option value="none">None</option>
                  <option value="relay">Relay</option>
                  <option value="customer">Customer</option>
                  <option value="carrier">Carrier</option>
                </select>
              </label>
              <label className="form-field">
                <span className="t-eyebrow form-field__label">Specific reason</span>
                <input
                  className="field"
                  name="note"
                  minLength={5}
                  maxLength={240}
                  defaultValue={opsState.blockerNote ?? ""}
                  placeholder="Required unless nobody is blocked"
                />
              </label>
              <button className="btn btn-secondary" type="submit">Save blocker</button>
              <p className="setup-panel__note">
                Clearing the blocker also clears its note and waiting timestamp. Every change is audited.
              </p>
            </form>
          ) : null}
        </section>

        {/* Money moment 1 — commercial setup and Stripe card readiness. */}
        <section className="panel setup-panel" aria-label="Kickoff fee">
          <div className="setup-panel__head">
            <p className="t-eyebrow">{isFoundingPilot ? "Founding pilot" : "Standard setup · $150"}</p>
            <h2>
              {pilotCardNeeded
                ? "Setup fee waived · Stripe card still needed."
                : kickoffCollectible
                  ? "Collect the $150, or make this an audited founding pilot."
                  : `Setup fee: ${kickoffState.toLowerCase()}.`}
            </h2>
            <p className="setup-copy">
              {isFoundingPilot
                ? "The waiver is a Relay exception, not a payment or refund. Stripe collects a card without charging it."
                : "Stripe charges the one-time setup fee and securely retains the card with clear consent."}
            </p>
          </div>
          {kickoffMessage ? (
            <div className={notices.kickoff === "failed" ? "intake-error settings-notice" : "settings-notice"} role="status">{kickoffMessage}</div>
          ) : null}
          {operator.role !== "support" && pilotCardNeeded ? (
            <div className="ops-billing-actions">
              <form action="/api/ops/kickoff" method="post">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <button className="btn btn-primary" name="action" value="send_invoice">Email secure card link</button>
              </form>
            </div>
          ) : operator.role !== "support" && kickoffCollectible ? (
            <div className="ops-billing-actions">
              <form action="/api/ops/kickoff" method="post"><input type="hidden" name="account_slug" value={summary.accountSlug} /><button className="btn btn-primary" name="action" value="send_invoice">{billing.setupFeeStatus === "due" ? "Email $150 payment link" : "Collect $150 again"}</button></form>
            </div>
          ) : (
            <p className="setup-panel__note">
              {setupFeeWaived || billing.setupFeeStatus === "waived"
                ? `Waived — recorded in the audit trail. Stripe card: ${billing.stripeDefaultPaymentMethodId ? "ready" : "not ready"}.`
                : kickoffCollectible
                  ? "The secure Stripe setup-payment link still needs to be sent or completed."
                : billing.setupFeeStatus === "disputed"
                  ? "The payment is disputed in Stripe. Sync after Stripe resolves the dispute."
                : `Settled${billing.firstPaidAt ? ` · first paid ${formatDate(billing.firstPaidAt)}` : ""}.`}
            </p>
          )}
          {billing.setupFeePaymentIntentId && operator.role !== "support" ? (
            <details className="ops-manual">
              <summary>Payment controls</summary>
              <div className="ops-billing-actions">
                <form action="/api/ops/billing/reconcile" method="post">
                  <input type="hidden" name="account_slug" value={summary.accountSlug} />
                  <button className="btn btn-secondary" type="submit">Sync with Stripe</button>
                </form>
              </div>
              {(billing.setupFeeStatus === "paid" || billing.setupFeeStatus === "partially_refunded") && operator.role === "super_admin" && stripePaymentUrl ? (
                <div className="setup-panel__action">
                  <a className="btn btn-secondary" href={stripePaymentUrl} target="_blank" rel="noreferrer">
                    Open payment in Stripe
                  </a>
                  <p className="setup-panel__note">Refunds, disputes, and payment history are managed in Stripe. Relay updates only from Stripe&apos;s signed events.</p>
                </div>
              ) : null}
            </details>
          ) : null}
        </section>

        {/* Money moment 2 — the $99 monthly. State first; actions are gated. */}
        <section className="panel setup-panel" aria-label="Monthly billing">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Monthly · $99</p>
            <h2 className={monthlyTone === "warn" ? "ops-money-warn" : undefined}>{monthlyState}</h2>
            <p className="setup-copy">
              {effectiveBillingStatus !== "not_started"
                ? "Stripe is the source of truth for monthly billing. A failed payment does not immediately interrupt call capture."
                : `The ${isFoundingPilot ? "30" : "14"}-day Stripe trial starts automatically only after calls, A2P, automatic text-back, commercial setup, and the Stripe card are ready. Calls alone never start trial time.`}
            </p>
          </div>
          {billingMessage ? (
            <div className={billingActionSucceeded(notices.billing_action) ? "settings-notice" : "intake-error settings-notice"} role="status">{billingMessage}</div>
          ) : null}
          {operator.role !== "support" && opsState.nextAction.key === "check_trial_activation" ? (
            <form action="/api/ops/billing/activate" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <button className="btn btn-primary" type="submit">Start eligible Stripe trial</button>
              <p className="setup-panel__note">The server rechecks real-call readiness, approved A2P, card readiness, account holds, and existing Stripe subscriptions before creating anything.</p>
            </form>
          ) : null}

          {/* Only super admins may grant a documented commercial exception. */}
          {operator.role === "super_admin" ? <details className="ops-manual">
            <summary>Super-admin commercial exceptions</summary>
            {!canApplyOverride ? (
              <p className="intake-error settings-notice">Locked: this account has a live Stripe subscription, so Stripe stays the source of truth. Use the Billing Portal instead.</p>
            ) : null}
            <form action="/api/ops/billing" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <label className="field-label" htmlFor="comp-reason">Reason</label>
              <input id="comp-reason" className="field" name="reason" maxLength={240} minLength={5} required placeholder="Why is this account comped or returned to standard billing?" />
              <label className="form-field">
                <span><input type="checkbox" name="confirmation" value="confirmed" required /> I confirm this commercial exception.</span>
              </label>
              <div className="ops-billing-actions" aria-label="Manual billing actions">
                <button className="btn btn-secondary" type="submit" name="action" value="comp" disabled={!canApplyOverride}>Comp account</button>
                <button className="btn btn-secondary" type="submit" name="action" value="uncomp" disabled={!canApplyOverride}>Remove comp</button>
              </div>
              <p className="setup-panel__note">Every exception is atomically recorded with its reason. Stripe subscription and payment history remain unchanged.</p>
            </form>
            {canApplyOverride && !kickoffSettled ? (
              <form action="/api/ops/billing" method="post" className="setup-panel__action">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <label className="field-label" htmlFor="setup-fee-waiver-reason">Setup-fee waiver reason</label>
                <div className="lead-controls ops-trial-controls">
                  <input id="setup-fee-waiver-reason" className="field" name="reason" maxLength={240} minLength={5} required placeholder="e.g. pilot customer" />
                  <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm waiver</label>
                  <button className="btn btn-secondary" type="submit" name="action" value="waive_setup_fee">Make founding pilot</button>
                </div>
              </form>
            ) : null}
            {billing.setupFeeStatus === "waived" && canApplyOverride ? (
              <form action="/api/ops/billing" method="post" className="setup-panel__action">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <label className="field-label" htmlFor="setup-fee-require-reason">Reason to require the setup fee</label>
                <div className="lead-controls ops-trial-controls">
                  <input id="setup-fee-require-reason" className="field" name="reason" maxLength={240} minLength={5} required placeholder="Why is the original waiver being removed?" />
                  <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm standard terms</label>
                  <button className="btn btn-secondary" type="submit" name="action" value="require_setup_fee">Return to standard terms</button>
                </div>
              </form>
            ) : null}
          </details> : null}
        </section>

        {/* Setup progress is operational only; it has no customer deadline. */}
        <section className="panel setup-panel" aria-label="Setup progress">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Calls</p>
            <h2>{setupStageCopy(opsState.calls)}</h2>
            <p className="setup-copy">A signed, real missed call records call capture as live. Billing and carrier review do not change that result.</p>
          </div>
          {notices.calls ? (
            <div className={notices.calls === "saved" ? "settings-notice" : "intake-error settings-notice"} role="status">
              {accountControlMessage}
            </div>
          ) : null}
          {operator.role !== "support" ? (
            <form action="/api/ops/calls" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <div className="lead-controls ops-trial-controls">
                <select className="field" name="account_control" defaultValue="" aria-label="Set explicit onboarding hold">
                  <option value="" disabled>Choose a call control…</option>
                  <option value="resume_onboarding">Resume onboarding</option>
                  <option value="pause_onboarding">Pause onboarding</option>
                </select>
                <button className="btn btn-secondary" type="submit">Update onboarding hold</button>
              </div>
              <p className="setup-panel__note">Ready comes only from a signed real call. Trial, Active, Attention, and Canceled come from Stripe.</p>
            </form>
          ) : null}
          {operator.role === "super_admin" ? (
            <details className="ops-manual">
              <summary>Super-admin account controls</summary>
              <form action="/api/ops/calls" method="post" className="setup-panel__action ops-form">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <label className="form-field">
                  <span className="t-eyebrow form-field__label">Sensitive action</span>
                  <select className="field" name="account_control" defaultValue="">
                    <option value="" disabled>Choose an action…</option>
                    <option value="pause_paid_service">Explicitly pause paid service</option>
                    <option value="close_account">Close account</option>
                    <option value="reopen_account">Reopen account</option>
                  </select>
                </label>
                <label className="form-field">
                  <span className="t-eyebrow form-field__label">Reason</span>
                  <input className="field" name="reason" minLength={5} maxLength={240} required />
                </label>
                <label><input type="checkbox" name="confirmation" value="confirmed" required /> I confirm this account action. Stripe billing will not be changed.</label>
                <button className="btn btn-secondary" type="submit">Apply account action</button>
              </form>
            </details>
          ) : null}
        </section>

        {/* Concierge onboarding: Relay can enter the customer's details from the
            setup call, so nothing waits on customer homework. */}
        <section className="panel setup-panel" aria-label="Business details">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Business details</p>
            <h2>{runtime?.businessName ?? summary.businessName}</h2>
            <p className="setup-copy">Enter or correct the practical account settings with the customer on the phone.</p>
          </div>
          {notices.profile ? (
            <div className={notices.profile === "saved" ? "settings-notice" : "intake-error settings-notice"} role="status">
              {notices.profile === "saved" ? "Business details saved on the customer's behalf." : notices.profile === "invalid" ? "Check the business name, email, and URLs." : "Save failed — check logs."}
            </div>
          ) : null}
          {operator.role !== "support" ? (
            <details className="ops-manual" open={Boolean(notices.profile && notices.profile !== "saved")}>
              <summary>Edit business details as Relay</summary>
              <form action="/api/ops/profile" method="post" className="setup-panel__action ops-form">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <label className="form-field"><span className="t-eyebrow form-field__label">Business display name</span><input className="field" name="business_name" required defaultValue={runtime?.businessName ?? summary.businessName} /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Owner / admin name</span><input className="field" name="owner_name" defaultValue={runtime?.ownerName ?? ""} /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Business type</span><input className="field" name="business_type" defaultValue={runtime?.businessType ?? ""} placeholder="e.g. Plumbing" /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Notification email</span><input className="field" type="email" name="owner_email" defaultValue={runtime?.ownerEmail ?? summary.ownerEmail ?? ""} /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Owner alert phone</span><input className="field" name="owner_phone_number" defaultValue={runtime?.ownerPhoneNumber ?? ""} /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Existing public business number</span><input className="field" name="public_business_number" defaultValue={runtime?.publicBusinessNumber ?? ""} /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Call mode</span><select className="field" name="call_mode" defaultValue={runtime?.callMode ?? "forwarding"}><option value="forwarding">Forwarding (keep their number)</option><option value="direct">Direct (Relay number is public)</option></select></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Scheduling link (optional)</span><input className="field" name="scheduling_url" defaultValue={runtime?.schedulingUrl ?? ""} placeholder="https://…" /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Voicemail greeting (text-to-speech, optional)</span><input className="field" name="missed_call_voice_message" defaultValue={runtime?.missedCallVoiceMessage ?? ""} /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Ring seconds before voicemail (5–60)</span><input className="field" name="dial_timeout_seconds" type="number" min={5} max={60} defaultValue={runtime?.dialTimeoutSeconds ?? 18} /></label>
                <label className="form-field"><span className="t-eyebrow form-field__label">Max voicemail seconds (10–300)</span><input className="field" name="voicemail_max_seconds" type="number" min={10} max={300} defaultValue={runtime?.voicemailMaxSeconds ?? 60} /></label>
                <button className="btn btn-primary" type="submit">Save for customer</button>
                <p className="setup-panel__note">Audited as entered by Relay. Completing these finishes the customer&apos;s &ldquo;Your details&rdquo; phase.</p>
              </form>
            </details>
          ) : null}
        </section>

        <section className="panel setup-panel" aria-label="Carrier registration">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Carrier registration</p>
            <h2>{carrierProfile?.status ? carrierProfile.status.replaceAll("_", " ") : "Waiting on registration information"}</h2>
            <p className="setup-copy">Legal and consent information stays separate from the Relay number and billing records. Relay can enter it with the customer.</p>
          </div>
          {notices.carrier ? (
            <div className={notices.carrier === "sync_failed" || notices.carrier === "invalid_ids" || notices.carrier === "unknown_status" ? "intake-error settings-notice" : "settings-notice"} role="status">
              {carrierNotice(notices.carrier)}
            </div>
          ) : null}
          {carrierProfile?.statusDetail ? (
            <p className="setup-copy">{carrierProfile.statusDetail}</p>
          ) : null}
          {operator.role !== "support" ? (
            <details className="ops-manual">
              <summary>Registration worksheet — what to collect from the customer</summary>
              <div className="ops-worksheet">
                <p className="setup-copy">Registration itself happens in the Twilio console (Trust Hub). Collect these on the setup call and enter them in Twilio. Relay does not store tax IDs.</p>
                <div className="ops-worksheet__cols">
                  <div>
                    <p className="t-eyebrow">Business with an EIN (Standard / Low-Volume)</p>
                    <ul>
                      <li>Legal business name + EIN</li>
                      <li>Business type (LLC, Corp, Partnership…) and private/public</li>
                      <li>Physical address (street, city, state, ZIP)</li>
                      <li>Industry and website</li>
                      <li>Regions of operation</li>
                      <li>Authorized rep: name, email, phone, title, and job position (Director/VP/GM/GC/CEO/CFO)</li>
                    </ul>
                  </div>
                  <div>
                    <p className="t-eyebrow">Sole proprietor (no EIN, US/CA only)</p>
                    <ul>
                      <li>Brand/business name</li>
                      <li>First and last name</li>
                      <li>Email address</li>
                      <li>Mobile phone (US/CA — validates max 3 brands)</li>
                      <li>Physical address (US/CA)</li>
                    </ul>
                  </div>
                </div>
                <p className="setup-panel__note">Campaign side (use case, opt-in flow, sample messages) is Relay-standard — reuse the approved missed-call template.</p>
              </div>
            </details>
          ) : null}
          {operator.role !== "support" ? (
            <form action="/api/ops/carrier" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <p className="t-eyebrow">Read status from Twilio</p>
              <p className="setup-copy">Copy the two identifiers from Twilio once. Relay reads the campaign result directly; an operator cannot mark A2P approved.</p>
              <label className="form-field">
                <span className="field-label">Messaging Service SID</span>
                <input className="field" name="messaging_service_sid" required pattern="MG[0-9a-fA-F]{32}" defaultValue={carrierProfile?.messagingServiceSid ?? ""} placeholder="MG…" />
              </label>
              <label className="form-field">
                <span className="field-label">A2P Campaign SID</span>
                <input className="field" name="twilio_campaign_sid" required pattern="QE[0-9a-fA-F]{32}" defaultValue={carrierProfile?.twilioCampaignSid ?? ""} placeholder="QE…" />
              </label>
              <button className="btn btn-secondary" type="submit">Sync from Twilio</button>
              <p className="setup-panel__note">Verified enables the customer&apos;s automatic-texting control; it does not turn texting on or start trial time by itself.</p>
            </form>
          ) : null}
        </section>

        <section className="panel setup-panel" aria-label="Relay number assignment">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Relay number</p>
            <h2>{runtime?.twilioPhoneNumber || "No number assigned"}</h2>
            <p className="setup-copy">Attach a number already owned in the configured Twilio account. Relay configures the voice and messaging callbacks automatically.</p>
          </div>
          {notices.number ? <div className={notices.number === "assigned" ? "settings-notice" : "intake-error settings-notice"} role="status">
            {notices.number === "assigned" ? "Relay number assigned and configured." : notices.number === "invalid" ? "Enter a US number in +1 format." : "Number assignment failed. No account routing was changed."}
          </div> : null}
          {operator.role !== "support" ? (
            <form action="/api/ops/twilio/assign" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <div className="lead-controls">
                <input className="field" name="phone_number" required pattern="\+1[0-9]{10}" placeholder="+12065550123" aria-label="Twilio phone number" />
                <button className="btn btn-primary" name="action" value="attach_existing">Attach owned number</button>
              </div>
              <p className="setup-panel__note">If the number is not already owned, this action fails without changing account routing.</p>
            </form>
          ) : null}
        </section>

        {/* Facts: everything else you might need, quietly. */}
        <section className="panel setup-panel" aria-label="Account facts">
          <div className="setup-panel__head"><p className="t-eyebrow">Facts</p></div>
          <dl className="webhook-event__meta">
            <div><dt>Owner email</dt><dd>{summary.ownerEmail ?? "not set"}</dd></div>
            <div><dt>Account slug</dt><dd>{summary.accountSlug}</dd></div>
            <div><dt>Subscription</dt><dd>{billing.stripeSubscriptionStatus ?? "not connected"}</dd></div>
            <div><dt>Stripe customer</dt><dd>{billing.stripeCustomerId ?? "none"}</dd></div>
            <div><dt>Trial ends</dt><dd>{formatDate(billing.trialEndsAt)}</dd></div>
            <div><dt>Renews</dt><dd>{formatDate(billing.currentPeriodEnd)}</dd></div>
            <div><dt>Activated</dt><dd>{formatDate(summary.activatedAt)}</dd></div>
            <div><dt>Last billing change</dt><dd>{formatDateTime(billing.billingUpdatedAt)}</dd></div>
          </dl>
        </section>

        {/* Diagnostics: raw events live here and only here. */}
        <details className="panel setup-panel ops-diagnostics" id="diagnostics">
          <summary>
            Diagnostics — raw billing and call events
            {failedCount > 0 ? <span className="chip chip-danger">{failedCount} failed</span> : null}
          </summary>
          <div className="ops-diagnostics__body">
            <div className="setup-panel__head">
              <p className="t-eyebrow">Billing events</p>
              <p className="setup-copy">Stripe webhook processing for this account, newest first.</p>
            </div>
            <div className="webhook-events">
              {stripeEvents.length === 0 ? <p className="empty-copy">No billing events yet.</p> : stripeEvents.map((event) => (
                <article className="webhook-event" key={event.event_id}>
                  <div className="webhook-event__head">
                    <strong>{event.event_type}</strong>
                    <span>{event.processing_status} · {formatDateTime(event.received_at)}</span>
                  </div>
                  <dl className="webhook-event__meta">
                    <div><dt>Event</dt><dd>{event.event_id}</dd></div>
                    <div><dt>Mode</dt><dd>{event.livemode ? "live" : "test"}</dd></div>
                    <div><dt>Reason / error</dt><dd>{event.error_code ?? event.ignore_reason ?? "none"}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
            <div className="setup-panel__head">
              <p className="t-eyebrow">Call &amp; text events</p>
              <p className="setup-copy">Raw system events, newest first.</p>
            </div>
            <div className="webhook-events">
              {systemEvents.length === 0 ? <p className="empty-copy">No system events yet.</p> : systemEvents.map((event) => (
                <article className="webhook-event" key={event.id}>
                  <div className="webhook-event__head">
                    <strong>{event.source}</strong>
                    <span>{event.response_status} · {formatDateTime(event.created_at)}</span>
                  </div>
                  <dl className="webhook-event__meta">
                    <div><dt>Correlation</dt><dd>{event.correlation_id ?? "none"}</dd></div>
                    <div><dt>Error</dt><dd>{event.error ?? "none"}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          </div>
        </details>
      </section>
    </main>
  );
}

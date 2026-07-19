import Link from "next/link";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { Icon } from "@/components/icon";
import { requirePlatformOperator } from "@/lib/auth";
import { canApplyOperatorBillingOverride, isSetupFeeSettled } from "@/lib/billing";
import { daysUntil } from "@/lib/onboarding-deadlines";
import { getOpsLifecycle } from "@/lib/ops-lifecycle";
import {
  canMoveAccountToCustomerDelay,
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

function kickoffNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "waived") return "Kickoff waived and recorded.";
  if (status === "card_saved") return "Card saved. This customer can be activated later.";
  if (status === "card_link_sent") return "Secure card-save link emailed to the customer. Monthly billing has not started.";
  if (status === "payment_link_sent") return "Secure $150 payment link emailed to the customer.";
  if (status === "canceled") return "Card setup canceled.";
  if (status === "failed") return "Kickoff action failed. No billing state was changed unless shown above.";
  return "Kickoff action received.";
}

function activationNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "comp") return "Account activated as a comped pilot.";
  if (status === "trial") return "Account activated with a trial.";
  if (status === "start_billing") return "Monthly billing started.";
  if (status === "payment_action_required") return "Monthly billing was created, but the customer must approve or update the payment in Stripe.";
  if (status === "card_missing") return "No usable saved kickoff card is attached. Send the customer through secure Stripe Checkout.";
  if (status === "billing_failed") return "Stripe could not start monthly billing. No local paid state was invented.";
  if (status === "account_not_found") return "Account not found.";
  if (status === "invalid_action") return "Choose a valid activation path.";
  if (status === "blocked") return "Activation is blocked until the account is ready.";
  return "Activation is ready.";
}

function billingActionNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "comp") return "Billing is now comped.";
  if (status === "uncomp") return "Manual comp removed. Account is back to not started.";
  if (status === "grant_trial") return "Manual trial granted.";
  if (status === "extend_trial") return "Manual trial extended.";
  if (status === "end_trial_now") return "Manual trial ended.";
  if (status === "waive_setup_fee") return "The $150 setup fee was waived and recorded.";
  if (status === "require_setup_fee") return "The $150 setup fee is required.";
  if (status === "refund_started") return "Stripe accepted the setup-fee refund. Relay will confirm it from Stripe.";
  if (status === "reconciled") return "Billing state refreshed from Stripe.";
  if (status === "refund_forbidden") return "Only a super admin can refund a payment.";
  if (status === "refund_unavailable") return "This setup payment cannot be refunded from Relay.";
  if (status === "refund_failed") return "Stripe could not create the refund. No local payment state was changed.";
  if (status === "reconcile_failed") return "Stripe reconciliation failed. Check Diagnostics before retrying.";
  if (status === "setup_fee_already_paid") return "Not changed. A paid setup fee cannot be overwritten.";
  if (status === "override_blocked") return "Not changed. Stripe has a live subscription, so Stripe remains the source of truth.";
  if (status === "setup_fee_required") return "Monthly billing is blocked until the setup fee is paid or waived.";
  if (status === "setup_incomplete") return "Monthly billing is blocked until call capture and carrier approval are complete.";
  if (status === "past_due") return "Monthly billing is past due; use the Billing Portal instead of starting another subscription.";
  if (status === "already_active") return "An active subscription already exists.";
  if (status === "subscription_incomplete") return "Stripe has an incomplete subscription; resolve it before retrying.";
  if (status === "checkout_failed") return "Stripe Checkout could not be started. Check the billing events below.";
  if (status === "save_failed") return "Billing change failed. Check logs before trying again.";
  if (status === "invalid_action") return "Choose a valid billing action.";
  return null;
}

function billingActionSucceeded(status: string | undefined) {
  return status === "comp" || status === "uncomp" || status === "grant_trial" ||
    status === "extend_trial" || status === "end_trial_now" ||
    status === "waive_setup_fee" || status === "require_setup_fee" ||
    status === "refund_started" || status === "reconciled";
}

function onboardingNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "requested") return "Customer requirements deadline started.";
  if (status === "reopened") return "Customer requirements deadline reopened with a new 14-day due date.";
  if (status === "not_customer_delay") return "Not changed. This account is not in a customer-delay state.";
  if (status === "save_failed") return "Deadline update failed. Check logs before trying again.";
  return null;
}

function setupStageCopy(status: string) {
  if (status === "requirements_needed") return "Waiting on business details from the customer.";
  if (status === "waiting_on_customer") return "Waiting on the customer to finish requirements.";
  if (status === "ready_for_carrier") return "Customer details are complete. Ready to submit for carrier review.";
  if (status === "carrier_review") return "Waiting on carrier approval — nothing needed from anyone.";
  if (status === "carrier_attention") return "Carrier approval needs attention.";
  if (status === "ready_for_live_test") return "Ready for a live missed-call test.";
  if (status === "ready_to_activate") return "Everything checks out. Ready to activate.";
  if (status === "activated") return "Activated and operating.";
  if (status === "paused_incomplete") return "Paused — the customer went quiet.";
  if (status === "closed_incomplete") return "Closed without finishing setup.";
  return status.replaceAll("_", " ");
}

export default async function OpsAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    kickoff?: string;
    activation?: string;
    billing_action?: string;
    onboarding?: string;
    carrier?: string;
    carrier_profile?: string;
    number?: string;
    profile?: string;
    stage_moved?: string;
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
          <OpsHeader operatorEmail={operator.email} />
          <div className="panel setup-panel ops-account-empty">
            <p className="t-eyebrow">Account not found</p>
            <h1 className="t-display">Choose another account.</h1>
            <p className="setup-copy">The requested account does not exist or is no longer available.</p>
            <Link className="btn btn-secondary" href="/ops">Back to pipeline</Link>
          </div>
        </section>
      </main>
    );
  }

  const lifecycle = getOpsLifecycle({
    onboardingStatus: billing.onboardingStatus,
    billingStatus: billing.billingStatus,
    setupFeeStatus: billing.setupFeeStatus,
    activatedAt: summary.activatedAt,
    updatedAt: summary.updatedAt,
  });

  const [stripeEvents, systemEvents, carrierProfile, runtime] = await Promise.all([
    getRecentStripeEventsForAccount(billing.accountId, 25),
    getRecentWebhookEventsForAccount(billing.accountId, 25),
    getCarrierProfile(billing.accountId),
    getAccountConfigByAccountId(billing.accountId),
  ]);
  const failedCount = stripeEvents.filter((event) => event.processing_status === "failed").length;

  const canApplyOverride = canApplyOperatorBillingOverride(billing);
  const canStartCustomerDelay = canMoveAccountToCustomerDelay(billing.onboardingStatus, billing);

  // Kickoff state, spelled out before any buttons.
  const kickoffSettled = isSetupFeeSettled(billing.setupFeeStatus, billing.firstPaidAt);
  const kickoffCollectible = billing.setupFeeStatus === "due" || billing.setupFeeStatus === "refunded" ||
    billing.setupFeeStatus === "charged_back";
  const kickoffState = billing.setupFeeStatus === "paid"
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
    billing.billingStatus === "active"
      ? `Active — $99/month${billing.currentPeriodEnd ? `, renews ${formatDate(billing.currentPeriodEnd)}` : ""}${billing.cancelAtPeriodEnd ? " (cancels at period end)" : ""}`
      : billing.billingStatus === "trialing"
        ? `Trial${billing.trialEndsAt ? ` — ends ${formatDate(billing.trialEndsAt)}` : ""}`
        : billing.billingStatus === "comped"
          ? "Comped — Relay is intentionally not charging"
          : billing.billingStatus === "past_due"
            ? "Past due — payment failed"
            : billing.billingStatus === "canceled"
              ? "Canceled"
              : "Not started";
  const monthlyTone = billing.billingStatus === "past_due" ? "warn" : "neutral";
  const readyToActivate = billing.onboardingStatus === "ready_to_activate";
  const canStartMonthly = readyToActivate && kickoffSettled &&
    billing.billingStatus !== "active" && billing.billingStatus !== "trialing" && billing.billingStatus !== "past_due";

  const kickoffMessage = kickoffNotice(notices.kickoff);
  const activationMessage = activationNotice(notices.activation);
  const billingMessage = billingActionNotice(notices.billing_action);
  const onboardingMessage = onboardingNotice(notices.onboarding);

  const dueDays = billing.requirementsDueAt ? daysUntil(billing.requirementsDueAt) : null;

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <OpsHeader businessName={summary.businessName} operatorEmail={operator.email} />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Customer</p>
            <h1 className="t-display">{summary.businessName}</h1>
            <p className="leads-subtitle">
              <span className={`lead-card__status-pill lead-card__status-pill--${lifecycle.stage === "active" ? "booked" : lifecycle.stage === "ready_to_activate" ? "new" : "contacted"}`}>{lifecycle.label}</span>
              {" "}· {summary.ownerEmail ?? "Owner not set"} · {summary.accountSlug}
            </p>
          </div>
          <div className="lead-actions">
            <Link className="btn btn-secondary btn-sm" href="/ops">
              <Icon name="arrowLeft" size={14} /> Pipeline
            </Link>
          </div>
        </div>

        <div className="settings-notice" role="status">
          You are signed in as operator <strong>{operator.email}</strong> and managing the separate customer account for <strong>{summary.ownerEmail ?? "an owner whose email is not set"}</strong>. Operator changes apply only to {summary.businessName}.
        </div>

        {/* The one thing to do next. */}
        <section className="readiness readiness--testing ops-next" aria-label="Next operator action">
          <div className="readiness__main">
            <span className="readiness__badge"><span className="readiness__dot" aria-hidden="true" />Next step</span>
            <h2 className="readiness__headline">{lifecycle.primaryAction}</h2>
            <p className="readiness__summary">
              {billing.billingStatus === "past_due"
                ? "Payment failed — open the billing events below, then have the owner update their card."
                : lifecycle.blockedOn}
              {lifecycle.daysInStage !== null ? ` · day ${lifecycle.daysInStage} in this stage` : ""}
            </p>
          </div>
        </section>

        {/* Money moment 1 — the $150 kickoff. State first, buttons only while due. */}
        <section className="panel setup-panel" aria-label="Kickoff fee">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Kickoff · $150</p>
            <h2>{kickoffCollectible ? "Collect the $150, or waive it deliberately." : `Setup fee: ${kickoffState.toLowerCase()}.`}</h2>
            <p className="setup-copy">Separate from the $99 monthly plan. Saving a card never starts monthly billing.</p>
          </div>
          {kickoffMessage ? (
            <div className={notices.kickoff === "failed" ? "intake-error settings-notice" : "settings-notice"} role="status">{kickoffMessage}</div>
          ) : null}
          {kickoffCollectible ? (
            <div className="ops-billing-actions">
              <form action="/api/ops/kickoff" method="post"><input type="hidden" name="account_slug" value={summary.accountSlug} /><button className="btn btn-primary" name="action" value="send_invoice">{billing.setupFeeStatus === "due" ? "Email $150 payment link" : "Collect $150 again"}</button></form>
              <form action="/api/ops/kickoff" method="post"><input type="hidden" name="account_slug" value={summary.accountSlug} /><button className="btn btn-secondary" name="action" value="waive_save_card">Waive + email card link</button></form>
              <form action="/api/ops/kickoff" method="post"><input type="hidden" name="account_slug" value={summary.accountSlug} /><button className="btn btn-secondary" name="action" value="waive_entirely">Waive entirely</button></form>
            </div>
          ) : (
            <p className="setup-panel__note">
              {billing.setupFeeStatus === "waived"
                ? "Waived — recorded in the audit trail."
                : billing.setupFeeStatus === "disputed"
                  ? "The payment is disputed in Stripe. Sync after Stripe resolves the dispute."
                : `Settled${billing.firstPaidAt ? ` · first paid ${formatDate(billing.firstPaidAt)}` : ""}.`}
            </p>
          )}
          {billing.setupFeeStatus === "waived" && canApplyOverride ? (
            <form action="/api/ops/billing" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <button className="btn btn-ghost btn-sm" type="submit" name="action" value="require_setup_fee">Require the fee again</button>
            </form>
          ) : null}
          {billing.setupFeePaymentIntentId ? (
            <details className="ops-manual">
              <summary>Payment controls</summary>
              <div className="ops-billing-actions">
                <form action="/api/ops/billing/reconcile" method="post">
                  <input type="hidden" name="account_slug" value={summary.accountSlug} />
                  <button className="btn btn-secondary" type="submit">Sync with Stripe</button>
                </form>
              </div>
              {(billing.setupFeeStatus === "paid" || billing.setupFeeStatus === "partially_refunded") && operator.role === "super_admin" ? (
                <form action="/api/ops/billing/refund" method="post" className="setup-panel__action">
                  <input type="hidden" name="account_slug" value={summary.accountSlug} />
                  <label className="field-label" htmlFor="setup-refund-reason">Refund reason</label>
                  <div className="lead-controls ops-trial-controls">
                    <input id="setup-refund-reason" className="field" name="reason" maxLength={240} required placeholder="Why is this being refunded?" />
                    <button className="btn btn-secondary" type="submit">Refund remaining setup fee</button>
                  </div>
                  <p className="setup-panel__note">This creates a real Stripe refund. Relay changes state only after Stripe confirms it.</p>
                </form>
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
              {readyToActivate || billing.billingStatus !== "not_started"
                ? "Stripe is the source of truth once a live subscription exists. Missed-call capture is never interrupted by billing."
                : `Not ready to bill yet — ${setupStageCopy(billing.onboardingStatus).toLowerCase()} A delay here never starts a billing clock.`}
            </p>
          </div>
          {activationMessage ? (
            <div className={notices.activation === "account_not_found" || notices.activation === "invalid_action" || notices.activation === "blocked" ? "intake-error settings-notice" : "settings-notice"} role="status">{activationMessage}</div>
          ) : null}
          {billingMessage ? (
            <div className={billingActionSucceeded(notices.billing_action) ? "settings-notice" : "intake-error settings-notice"} role="status">{billingMessage}</div>
          ) : null}

          {canStartMonthly ? (
            <div className="ops-billing-actions">
              <form action="/api/ops/activate" method="post"><input type="hidden" name="account_slug" value={summary.accountSlug} /><button className="btn btn-primary" name="action" value="start_billing">Start $99 billing</button></form>
              <form action="/api/ops/activate" method="post"><input type="hidden" name="account_slug" value={summary.accountSlug} /><button className="btn btn-secondary" name="action" value="comp">Comp pilot</button></form>
              <form action="/api/ops/activate" method="post"><input type="hidden" name="account_slug" value={summary.accountSlug} /><input type="hidden" name="trial_days" value="30" /><button className="btn btn-secondary" name="action" value="trial">30-day trial</button></form>
            </div>
          ) : null}
          {readyToActivate && !kickoffSettled ? (
            <p className="setup-panel__note">Settle the kickoff above (pay or waive) before starting monthly billing.</p>
          ) : null}

          {/* Operator billing controls: manual comp/trial when Stripe isn't in charge. */}
          <details className="ops-manual">
            <summary>Operator billing controls — manual comp or trial</summary>
            {!canApplyOverride ? (
              <p className="intake-error settings-notice">Locked: this account has a live Stripe subscription, so Stripe stays the source of truth. Use the Billing Portal instead.</p>
            ) : null}
            <form action="/api/ops/billing" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <div className="ops-billing-actions" aria-label="Manual billing actions">
                <button className="btn btn-secondary" type="submit" name="action" value="comp" disabled={!canApplyOverride}>Comp account</button>
                <button className="btn btn-secondary" type="submit" name="action" value="uncomp" disabled={!canApplyOverride}>Remove comp</button>
              </div>
              <label className="field-label" htmlFor="billing-trial-days">Trial days</label>
              <div className="lead-controls ops-trial-controls">
                <input id="billing-trial-days" className="field" name="trial_days" type="number" min="7" max="90" defaultValue="30" />
                <button className="btn btn-primary" type="submit" name="action" value="grant_trial" disabled={!canApplyOverride}>Grant trial</button>
                <button className="btn btn-secondary" type="submit" name="action" value="extend_trial" disabled={!canApplyOverride}>Extend trial</button>
                <button className="btn btn-secondary" type="submit" name="action" value="end_trial_now" disabled={!canApplyOverride}>End trial now</button>
              </div>
              <p className="setup-panel__note">Every change is audited. Manual comp/trial never resets activation, first-paid, or guarantee dates.</p>
            </form>
            {canApplyOverride && !kickoffSettled ? (
              <form action="/api/ops/billing" method="post" className="setup-panel__action">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <label className="field-label" htmlFor="setup-fee-waiver-reason">Setup-fee waiver reason</label>
                <div className="lead-controls ops-trial-controls">
                  <input id="setup-fee-waiver-reason" className="field" name="waiver_reason" maxLength={240} placeholder="e.g. pilot customer" />
                  <button className="btn btn-secondary" type="submit" name="action" value="waive_setup_fee">Waive $150 setup fee</button>
                </div>
              </form>
            ) : null}
          </details>
        </section>

        {/* Setup progress + the customer-delay clock for this account. */}
        <section className="panel setup-panel" aria-label="Setup progress">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Setup progress</p>
            <h2>{setupStageCopy(billing.onboardingStatus)}</h2>
            {billing.requirementsDueAt ? (
              <p className="setup-copy">
                Customer requirements {dueDays === null ? "" : dueDays > 0 ? `due in ${dueDays} day${dueDays === 1 ? "" : "s"}` : dueDays === 0 ? "due today" : `${Math.abs(dueDays)} day${Math.abs(dueDays) === 1 ? "" : "s"} overdue`} ({formatDate(billing.requirementsDueAt)}).
              </p>
            ) : (
              <p className="setup-copy">Carrier review time never counts against the customer, and never starts billing.</p>
            )}
          </div>
          {onboardingMessage ? (
            <div className={notices.onboarding === "requested" || notices.onboarding === "reopened" ? "settings-notice" : "intake-error settings-notice"} role="status">{onboardingMessage}</div>
          ) : null}
          {notices.stage_moved ? (
            <div className={notices.stage_moved === "saved" ? "settings-notice" : "intake-error settings-notice"} role="status">
              {notices.stage_moved === "saved" ? "Stage updated." : "Stage change failed — pick a valid stage."}
            </div>
          ) : null}
          {operator.role !== "support" ? (
            <form action="/api/ops/stage" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <div className="lead-controls ops-trial-controls">
                <select className="field" name="stage" defaultValue={lifecycle.stage} aria-label="Move to stage">
                  <option value="kickoff">Kickoff</option>
                  <option value="setting_up">Setting up</option>
                  <option value="carrier_review">Carrier review</option>
                  <option value="ready_to_activate">Ready</option>
                  <option value="paused">Paused</option>
                </select>
                <button className="btn btn-secondary" type="submit">Move stage</button>
              </div>
              <p className="setup-panel__note">Active and Canceled move through Activate and Stripe, never manually.</p>
            </form>
          ) : null}
          {canStartCustomerDelay ? (
            <form action="/api/ops/onboarding-deadlines" method="post" className="setup-panel__action">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <button className="btn btn-secondary" type="submit">Start / reopen the 14-day customer clock</button>
              <p className="setup-panel__note">Use only when Relay is waiting on the customer — never for carrier review.</p>
            </form>
          ) : null}
        </section>

        {/* Concierge onboarding: Relay can enter the customer's details from the
            setup call, so nothing waits on customer homework. */}
        <section className="panel setup-panel" aria-label="Business details">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Business details</p>
            <h2>{runtime?.businessName ?? summary.businessName}</h2>
            <p className="setup-copy">Enter or correct these with the customer on the phone. The customer sees the same data in their Settings.</p>
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
          {notices.carrier ? <div className="settings-notice" role="status">Carrier status updated: {notices.carrier.replaceAll("_", " ")}.</div> : null}
          {notices.carrier_profile ? (
            <div className={notices.carrier_profile === "saved" ? "settings-notice" : "intake-error settings-notice"} role="status">
              {notices.carrier_profile === "saved"
                ? "Carrier registration information saved on the customer's behalf."
                : notices.carrier_profile === "incomplete"
                  ? "Missing required fields — representative, use case, consent flow, and at least two sample messages."
                  : notices.carrier_profile === "registration_id_required"
                    ? "An EIN registration number is required when the business has an EIN."
                    : "Check the URLs — they must start with https://."}
            </div>
          ) : null}
          {carrierProfile ? (
            <dl className="webhook-event__meta">
              <div><dt>Business registration</dt><dd>{carrierProfile.hasEin ? `EIN ending ${carrierProfile.registrationIdLast4 ?? "not saved"}` : "Sole proprietor"}</dd></div>
              <div><dt>Representative</dt><dd>{[carrierProfile.representativeFirstName, carrierProfile.representativeLastName].filter(Boolean).join(" ") || "not set"}</dd></div>
              <div><dt>Consent flow</dt><dd>{carrierProfile.optInFlow ? "provided" : "missing"}</dd></div>
              <div><dt>Sample messages</dt><dd>{carrierProfile.sampleMessages.length}</dd></div>
            </dl>
          ) : null}
          {operator.role !== "support" ? (
            <details className="ops-manual">
              <summary>Registration worksheet — what to collect from the customer</summary>
              <div className="ops-worksheet">
                <p className="setup-copy">Registration itself happens in the Twilio console (Trust Hub). Collect these on the setup call, enter them in Twilio, then mark the status below. Relay does not store tax IDs.</p>
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
              <p className="t-eyebrow">Track carrier status (registered in the Twilio console)</p>
              <p className="setup-copy">When Twilio&apos;s Trust Hub status changes, click the match here. Approve is what turns on texting and moves the customer forward.</p>
              <input className="field" name="status_detail" defaultValue={carrierProfile?.statusDetail ?? ""} placeholder="Owner-facing note (optional, shown to the customer)" />
              <div className="ops-billing-actions">
                <button className="btn btn-secondary" name="action" value="submitted">Mark submitted</button>
                <button className="btn btn-secondary" name="action" value="in_progress">In review</button>
                <button className="btn btn-primary" name="action" value="approved">Approve</button>
                <button className="btn btn-secondary" name="action" value="needs_changes">Needs changes</button>
                <button className="btn btn-secondary" name="action" value="rejected">Rejected</button>
                <button className="btn btn-secondary" name="action" value="ready_to_activate">Mark ready to activate (override)</button>
              </div>
            </form>
          ) : null}
        </section>

        <section className="panel setup-panel" aria-label="Relay number assignment">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Relay number</p>
            <h2>{runtime?.twilioPhoneNumber || "No number assigned"}</h2>
            <p className="setup-copy">Attach a number already owned in Twilio, or purchase a specific available number. Relay configures the voice and messaging callbacks automatically.</p>
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
                <button className="btn btn-secondary" name="action" value="purchase">Purchase this number</button>
              </div>
              <p className="setup-panel__note">Purchasing creates a real Twilio charge. Use Attach when the number already appears in your Twilio account.</p>
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

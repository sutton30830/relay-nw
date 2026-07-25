import Link from "next/link";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { Icon } from "@/components/icon";
import { requirePlatformOperator } from "@/lib/auth";
import { canApplyOperatorBillingOverride, isSetupFeeSettled } from "@/lib/billing";
import {
  deriveOpsState,
  type OpsCallsState,
  type OpsNextActionKey,
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

// One workspace per customer, in reading order: four independent facts and one
// next action → setup and billing → collapsed customer details and diagnostics.
// Phase 4A's role, audit, Stripe, Twilio, and real-call authority is unchanged;
// this page only makes those boundaries easier to operate.

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

function nextActionDestination(key: OpsNextActionKey) {
  if (
    key === "resolve_billing" ||
    key === "review_cancellation" ||
    key === "review_canceled_subscription" ||
    key === "complete_setup_payment" ||
    key === "collect_payment_method" ||
    key === "check_trial_activation"
  ) {
    return "#billing";
  }
  return key === "none" ? null : "#setup";
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
  const carrierMessage = carrierNotice(notices.carrier);
  const numberMessage = notices.number === "assigned"
    ? "Relay number assigned and configured."
    : notices.number === "invalid"
      ? "Enter a US number in +1 format."
      : notices.number
        ? "Number assignment failed. No account routing was changed."
        : null;
  const profileMessage = notices.profile === "saved"
    ? "Business details saved on the customer's behalf."
    : notices.profile === "invalid"
      ? "Check the business name, email, and URLs."
      : notices.profile
        ? "Business-details save failed. Check logs before retrying."
        : null;
  const primaryDestination = nextActionDestination(opsState.nextAction.key);
  const setupControlsOpen =
    primaryDestination === "#setup" ||
    Boolean(
      (notices.blocker && notices.blocker !== "saved") ||
      (notices.carrier && !carrierMessage?.startsWith("Twilio campaign status synchronized")) ||
      (notices.number && notices.number !== "assigned") ||
      (notices.calls && notices.calls !== "saved"),
    );
  const queuePillTone =
    opsState.queueGroup === "running"
      ? "booked"
      : opsState.queueGroup === "onboarding"
        ? "new"
        : "contacted";
  return (
    <main className="leads-view">
      <section className="leads-shell ops-account-workspace">
        <OpsHeader businessName={summary.businessName} currentPage="accounts" operatorEmail={operator.email} />

        <div className="leads-header ops-account-workspace__head">
          <div>
            <p className="t-eyebrow">Account workspace</p>
            <h1 className="t-display">{summary.businessName}</h1>
            <p className="leads-subtitle">
              <span className={`lead-card__status-pill lead-card__status-pill--${queuePillTone}`}>{opsState.queueLabel}</span>
              {" "}· {runtime?.ownerName || summary.ownerEmail || "Owner not set"}
            </p>
          </div>
          <Link className="btn btn-secondary btn-sm" href="/ops">
            <Icon name="arrowLeft" size={14} /> Work queue
          </Link>
        </div>

        <div className="ops-workspace-notices" aria-live="polite">
          <div className="settings-notice">
            Managing <strong>{summary.businessName}</strong> as {operator.email}. Changes stay scoped to this customer.
          </div>
          {kickoffMessage ? <div className={notices.kickoff === "failed" ? "intake-error settings-notice" : "settings-notice"}>{kickoffMessage}</div> : null}
          {billingMessage ? <div className={billingActionSucceeded(notices.billing_action) ? "settings-notice" : "intake-error settings-notice"}>{billingMessage}</div> : null}
          {blockerMessage ? <div className={notices.blocker === "saved" ? "settings-notice" : "intake-error settings-notice"}>{blockerMessage}</div> : null}
          {carrierMessage ? <div className={notices.carrier === "sync_failed" || notices.carrier === "invalid_ids" || notices.carrier === "unknown_status" || notices.carrier === "save_failed" ? "intake-error settings-notice" : "settings-notice"}>{carrierMessage}</div> : null}
          {numberMessage ? <div className={notices.number === "assigned" ? "settings-notice" : "intake-error settings-notice"}>{numberMessage}</div> : null}
          {profileMessage ? <div className={notices.profile === "saved" ? "settings-notice" : "intake-error settings-notice"}>{profileMessage}</div> : null}
          {accountControlMessage ? <div className={notices.calls === "saved" ? "settings-notice" : "intake-error settings-notice"}>{accountControlMessage}</div> : null}
        </div>

        <section className="panel ops-workspace-command" aria-label="Account command center">
          <dl className="ops-workspace-status" aria-label="Independent account statuses">
            <div><dt>Calls</dt><dd>{opsState.labels.calls}</dd></div>
            <div><dt>Texting</dt><dd>{opsState.labels.texting}</dd></div>
            <div><dt>Billing</dt><dd>{opsState.labels.billing}</dd></div>
            <div className={opsState.blockedBy === "none" ? undefined : "ops-workspace-status__attention"}>
              <dt>Blocked by</dt>
              <dd>{opsState.labels.blocker}{opsState.blockedAgeDays !== null ? ` · ${opsState.blockedAgeDays}d` : ""}</dd>
            </div>
          </dl>
          <div className="ops-workspace-primary" aria-label="Primary operator action">
            <div>
              <p className="t-eyebrow">Next action</p>
              <h2>{opsState.nextAction.label}</h2>
              <p>{opsState.nextAction.detail}</p>
            </div>
            {operator.role !== "support" && opsState.nextAction.key === "check_trial_activation" ? (
              <form action="/api/ops/billing/activate" method="post">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <button className="btn btn-primary" type="submit">Start eligible Stripe trial</button>
              </form>
            ) : operator.role !== "support" && (opsState.nextAction.key === "complete_setup_payment" || opsState.nextAction.key === "collect_payment_method") ? (
              <form action="/api/ops/kickoff" method="post">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <button className="btn btn-primary" name="action" value="send_invoice">
                  {pilotCardNeeded ? "Email secure card link" : billing.setupFeeStatus === "due" ? "Email $150 payment link" : "Collect $150 again"}
                </button>
              </form>
            ) : primaryDestination ? (
              <Link className="btn btn-primary" href={primaryDestination}>
                {primaryDestination === "#billing" ? "Open billing" : "Open setup"}
              </Link>
            ) : null}
          </div>
        </section>

        <div className="ops-workspace-grid">
          <section className="panel setup-panel ops-workspace-card" id="setup" aria-label="Setup">
            <div className="setup-panel__head">
              <p className="t-eyebrow">Setup</p>
              <h2>Calls and texting</h2>
              <p className="setup-copy">These move independently. A signed real call controls call readiness; Twilio and the carrier control A2P.</p>
            </div>
            <div className="ops-workspace-rows">
              <div>
                <span>Calls</span>
                <strong>{setupStageCopy(opsState.calls)}</strong>
                <small>Relay number: {runtime?.twilioPhoneNumber || "not assigned"}</small>
              </div>
              <div>
                <span>Texting</span>
                <strong>{opsState.labels.texting}</strong>
                <small>{carrierProfile?.statusDetail || "Automatic text-back waits for carrier approval and customer activation."}</small>
              </div>
              <div className={opsState.blockedBy === "none" ? undefined : "ops-workspace-row--attention"}>
                <span>Blocker</span>
                <strong>{opsState.labels.blocker}{opsState.blockedAgeDays !== null ? ` · ${opsState.blockedAgeDays} days` : ""}</strong>
                <small>{opsState.blockerNote || "No recorded blocker."}</small>
              </div>
            </div>

            {operator.role !== "support" ? (
              <details className="ops-manual ops-workspace-controls" open={setupControlsOpen}>
                <summary>Setup controls</summary>
                <div className="ops-workspace-controls__body">
                  <form action="/api/ops/blocker" method="post" className="setup-panel__action ops-form" id="blocker-control">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <p className="t-eyebrow">Blocker ownership</p>
                    <label className="form-field">
                      <span className="form-field__label">Blocked by</span>
                      <select className="field" name="blocked_by" defaultValue={opsState.blockedBy}>
                        <option value="none">None</option>
                        <option value="relay">Relay</option>
                        <option value="customer">Customer</option>
                        <option value="carrier">Carrier</option>
                      </select>
                    </label>
                    <label className="form-field">
                      <span className="form-field__label">Specific reason</span>
                      <input className="field" name="note" minLength={5} maxLength={240} defaultValue={opsState.blockerNote ?? ""} placeholder="Required unless nobody is blocked" />
                    </label>
                    <button className="btn btn-secondary" type="submit">Save blocker</button>
                    <p className="setup-panel__note">Clearing the blocker also clears its note and waiting timestamp. Every change is audited.</p>
                  </form>

                  <form action="/api/ops/twilio/assign" method="post" className="setup-panel__action ops-form">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <p className="t-eyebrow">Relay number</p>
                    <p className="setup-copy">Attach a number already owned in the configured Twilio account.</p>
                    <div className="lead-controls">
                      <input className="field" name="phone_number" required pattern="\+1[0-9]{10}" placeholder="+12065550123" aria-label="Twilio phone number" />
                      <button className="btn btn-secondary" name="action" value="attach_existing">Attach owned number</button>
                    </div>
                    <p className="setup-panel__note">An unowned number fails without changing account routing.</p>
                  </form>

                  <form action="/api/ops/carrier" method="post" className="setup-panel__action ops-form">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <p className="t-eyebrow">Carrier status</p>
                    <p className="setup-copy">Registration happens outside Relay. Enter the Twilio references once; Relay reads the campaign result directly, and an operator cannot mark A2P approved.</p>
                    <label className="form-field">
                      <span className="field-label">Messaging Service SID</span>
                      <input className="field" name="messaging_service_sid" required pattern="MG[0-9a-fA-F]{32}" defaultValue={carrierProfile?.messagingServiceSid ?? ""} placeholder="MG…" />
                    </label>
                    <label className="form-field">
                      <span className="field-label">A2P Campaign SID</span>
                      <input className="field" name="twilio_campaign_sid" required pattern="QE[0-9a-fA-F]{32}" defaultValue={carrierProfile?.twilioCampaignSid ?? ""} placeholder="QE…" />
                    </label>
                    <button className="btn btn-secondary" type="submit">Sync from Twilio</button>
                    <p className="setup-panel__note">Approval does not turn texting on or start trial time by itself.</p>
                  </form>

                  <form action="/api/ops/calls" method="post" className="setup-panel__action ops-form">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <p className="t-eyebrow">Onboarding hold</p>
                    <div className="lead-controls ops-trial-controls">
                      <select className="field" name="account_control" defaultValue="" aria-label="Set explicit onboarding hold">
                        <option value="" disabled>Choose a hold action…</option>
                        <option value="resume_onboarding">Resume onboarding</option>
                        <option value="pause_onboarding">Pause onboarding</option>
                      </select>
                      <button className="btn btn-secondary" type="submit">Apply</button>
                    </div>
                    <p className="setup-panel__note">Ready still comes only from a signed real call.</p>
                  </form>
                </div>
              </details>
            ) : null}
          </section>

          <section className="panel setup-panel ops-workspace-card" id="billing" aria-label="Billing">
            <div className="setup-panel__head">
              <p className="t-eyebrow">Billing</p>
              <h2>Stripe-owned money state</h2>
              <p className="setup-copy">Relay shows Stripe&apos;s truth and controls technical eligibility. Payment methods, invoices, refunds, retries, disputes, and cancellation stay in Stripe.</p>
            </div>
            <div className="ops-workspace-rows">
              <div>
                <span>{isFoundingPilot ? "Founding pilot setup" : "Setup fee · $150"}</span>
                <strong>{kickoffState}</strong>
                <small>{setupFeeWaived ? `Waived with audit trail · card ${billing.stripeDefaultPaymentMethodId ? "ready" : "not ready"}` : billing.firstPaidAt ? `Paid ${formatDate(billing.firstPaidAt)}` : "Collected securely through Stripe"}</small>
              </div>
              <div className={monthlyTone === "warn" ? "ops-workspace-row--attention" : undefined}>
                <span>Monthly · $99</span>
                <strong>{monthlyState}</strong>
                <small>{effectiveBillingStatus === "not_started" ? `${isFoundingPilot ? "30" : "14"}-day trial waits for full automatic text-back activation.` : "A failed payment does not immediately interrupt call capture."}</small>
              </div>
            </div>

            {operator.role !== "support" ? (
              <details className="ops-manual ops-workspace-controls" open={Boolean(notices.billing_action && !billingActionSucceeded(notices.billing_action))}>
                <summary>Billing controls</summary>
                <div className="ops-workspace-controls__body">
                  {(pilotCardNeeded || kickoffCollectible) && opsState.nextAction.key !== "complete_setup_payment" && opsState.nextAction.key !== "collect_payment_method" ? (
                    <form action="/api/ops/kickoff" method="post" className="setup-panel__action">
                      <input type="hidden" name="account_slug" value={summary.accountSlug} />
                      <button className="btn btn-secondary" name="action" value="send_invoice">
                        {pilotCardNeeded ? "Email secure card link" : billing.setupFeeStatus === "due" ? "Email $150 payment link" : "Collect $150 again"}
                      </button>
                    </form>
                  ) : null}
                  <form action="/api/ops/billing/reconcile" method="post" className="setup-panel__action">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <button className="btn btn-secondary" type="submit">Sync with Stripe</button>
                  </form>
                  {(billing.setupFeeStatus === "paid" || billing.setupFeeStatus === "partially_refunded") && operator.role === "super_admin" && stripePaymentUrl ? (
                    <div className="setup-panel__action">
                      <a className="btn btn-secondary" href={stripePaymentUrl} target="_blank" rel="noreferrer">Open payment in Stripe</a>
                      <p className="setup-panel__note">Refunds and disputes are managed in Stripe. Relay updates only from signed Stripe events.</p>
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}

            {operator.role === "super_admin" ? (
              <details className="ops-manual">
                <summary>Super-admin commercial exceptions</summary>
                {!canApplyOverride ? <p className="intake-error settings-notice">Locked: this account has a live Stripe subscription, so Stripe stays authoritative.</p> : null}
                <form action="/api/ops/billing" method="post" className="setup-panel__action ops-form">
                  <input type="hidden" name="account_slug" value={summary.accountSlug} />
                  <label className="field-label" htmlFor="comp-reason">Reason</label>
                  <input id="comp-reason" className="field" name="reason" maxLength={240} minLength={5} required placeholder="Why is this commercial exception appropriate?" />
                  <label><input type="checkbox" name="confirmation" value="confirmed" required /> I confirm this commercial exception.</label>
                  <div className="ops-billing-actions" aria-label="Manual billing actions">
                    <button className="btn btn-secondary" type="submit" name="action" value="comp" disabled={!canApplyOverride}>Comp account</button>
                    <button className="btn btn-secondary" type="submit" name="action" value="uncomp" disabled={!canApplyOverride}>Remove comp</button>
                  </div>
                </form>
                {canApplyOverride && !kickoffSettled ? (
                  <form action="/api/ops/billing" method="post" className="setup-panel__action ops-form">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <label className="field-label" htmlFor="setup-fee-waiver-reason">Setup-fee waiver reason</label>
                    <input id="setup-fee-waiver-reason" className="field" name="reason" maxLength={240} minLength={5} required placeholder="e.g. founding pilot" />
                    <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm waiver</label>
                    <button className="btn btn-secondary" type="submit" name="action" value="waive_setup_fee">Make founding pilot</button>
                  </form>
                ) : null}
                {billing.setupFeeStatus === "waived" && canApplyOverride ? (
                  <form action="/api/ops/billing" method="post" className="setup-panel__action ops-form">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <label className="field-label" htmlFor="setup-fee-require-reason">Reason to require setup fee</label>
                    <input id="setup-fee-require-reason" className="field" name="reason" maxLength={240} minLength={5} required />
                    <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm standard terms</label>
                    <button className="btn btn-secondary" type="submit" name="action" value="require_setup_fee">Return to standard terms</button>
                  </form>
                ) : null}
              </details>
            ) : null}
          </section>
        </div>

        <details className="panel setup-panel ops-customer-details" open={Boolean(notices.profile && notices.profile !== "saved")}>
          <summary>
            <span><strong>Customer details</strong><small>Contact, routing, and account settings</small></span>
          </summary>
          <div className="ops-customer-details__body">
            <dl className="ops-workspace-facts">
              <div><dt>Owner</dt><dd>{runtime?.ownerName || "Not set"}</dd></div>
              <div><dt>Owner email</dt><dd>{runtime?.ownerEmail || summary.ownerEmail || "Not set"}</dd></div>
              <div><dt>Owner phone</dt><dd>{runtime?.ownerPhoneNumber || "Not set"}</dd></div>
              <div><dt>Public number</dt><dd>{runtime?.publicBusinessNumber || "Not set"}</dd></div>
              <div><dt>Relay number</dt><dd>{runtime?.twilioPhoneNumber || "Not assigned"}</dd></div>
              <div><dt>Call mode</dt><dd>{runtime?.callMode || "forwarding"}</dd></div>
              <div><dt>Account</dt><dd>{summary.accountSlug}</dd></div>
              <div><dt>Activated</dt><dd>{formatDate(summary.activatedAt)}</dd></div>
            </dl>
            {operator.role !== "support" ? (
              <form action="/api/ops/profile" method="post" className="setup-panel__action ops-form">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <p className="t-eyebrow">Edit customer details</p>
                <label className="form-field"><span className="form-field__label">Business display name</span><input className="field" name="business_name" required defaultValue={runtime?.businessName ?? summary.businessName} /></label>
                <label className="form-field"><span className="form-field__label">Owner / admin name</span><input className="field" name="owner_name" defaultValue={runtime?.ownerName ?? ""} /></label>
                <label className="form-field"><span className="form-field__label">Business type</span><input className="field" name="business_type" defaultValue={runtime?.businessType ?? ""} placeholder="e.g. Plumbing" /></label>
                <label className="form-field"><span className="form-field__label">Notification email</span><input className="field" type="email" name="owner_email" defaultValue={runtime?.ownerEmail ?? summary.ownerEmail ?? ""} /></label>
                <label className="form-field"><span className="form-field__label">Owner alert phone</span><input className="field" name="owner_phone_number" defaultValue={runtime?.ownerPhoneNumber ?? ""} /></label>
                <label className="form-field"><span className="form-field__label">Existing public business number</span><input className="field" name="public_business_number" defaultValue={runtime?.publicBusinessNumber ?? ""} /></label>
                <label className="form-field"><span className="form-field__label">Call mode</span><select className="field" name="call_mode" defaultValue={runtime?.callMode ?? "forwarding"}><option value="forwarding">Forwarding (keep their number)</option><option value="direct">Direct (Relay number is public)</option></select></label>
                <label className="form-field"><span className="form-field__label">Scheduling link (optional)</span><input className="field" name="scheduling_url" defaultValue={runtime?.schedulingUrl ?? ""} placeholder="https://…" /></label>
                <label className="form-field"><span className="form-field__label">Voicemail greeting (optional)</span><input className="field" name="missed_call_voice_message" defaultValue={runtime?.missedCallVoiceMessage ?? ""} /></label>
                <label className="form-field"><span className="form-field__label">Ring seconds before voicemail (5–60)</span><input className="field" name="dial_timeout_seconds" type="number" min={5} max={60} defaultValue={runtime?.dialTimeoutSeconds ?? 18} /></label>
                <label className="form-field"><span className="form-field__label">Max voicemail seconds (10–300)</span><input className="field" name="voicemail_max_seconds" type="number" min={10} max={300} defaultValue={runtime?.voicemailMaxSeconds ?? 60} /></label>
                <button className="btn btn-primary" type="submit">Save customer details</button>
              </form>
            ) : null}
            {operator.role === "super_admin" ? (
              <details className="ops-manual">
                <summary>Super-admin account controls</summary>
                <form action="/api/ops/calls" method="post" className="setup-panel__action ops-form">
                  <input type="hidden" name="account_slug" value={summary.accountSlug} />
                  <label className="form-field">
                    <span className="form-field__label">Sensitive action</span>
                    <select className="field" name="account_control" defaultValue="">
                      <option value="" disabled>Choose an action…</option>
                      <option value="pause_paid_service">Explicitly pause paid service</option>
                      <option value="close_account">Close account</option>
                      <option value="reopen_account">Reopen account</option>
                    </select>
                  </label>
                  <label className="form-field"><span className="form-field__label">Reason</span><input className="field" name="reason" minLength={5} maxLength={240} required /></label>
                  <label><input type="checkbox" name="confirmation" value="confirmed" required /> I confirm this account action. Stripe billing will not be changed.</label>
                  <button className="btn btn-secondary" type="submit">Apply account action</button>
                </form>
              </details>
            ) : null}
          </div>
        </details>

        <details className="panel setup-panel ops-diagnostics" id="diagnostics">
          <summary>
            Diagnostics
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
                  <div className="webhook-event__head"><strong>{event.event_type}</strong><span>{event.processing_status} · {formatDateTime(event.received_at)}</span></div>
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
                  <div className="webhook-event__head"><strong>{event.source}</strong><span>{event.response_status} · {formatDateTime(event.created_at)}</span></div>
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

import Link from "next/link";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { Icon } from "@/components/icon";
import { requirePlatformOperator } from "@/lib/auth";
import { canApplyOperatorBillingOverride, isSetupFeeSettled } from "@/lib/billing";
import {
  deriveOpsState,
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
  if (key === "resolve_relay_blocker" || key === "follow_up_customer" || key === "monitor_carrier_blocker") return "#blocker";
  if (key === "review_call_hold" || key === "finish_call_setup" || key === "help_with_forwarding") return "#calls";
  if (key === "resolve_texting_issue" || key === "prepare_a2p" || key === "monitor_carrier_review" || key === "enable_text_back") return "#texting";
  if (key === "resolve_billing" || key === "review_cancellation" || key === "review_canceled_subscription") return "#billing";
  return null;
}

function nextActionButtonLabel(key: OpsNextActionKey) {
  if (key === "resolve_relay_blocker" || key === "follow_up_customer" || key === "monitor_carrier_blocker") return "Update blocker";
  if (key === "review_call_hold") return "Review call settings";
  if (key === "finish_call_setup") return "Assign Relay number";
  if (key === "help_with_forwarding") return "Open call setup";
  if (key === "resolve_texting_issue") return "Review texting";
  if (key === "prepare_a2p") return "Set up A2P";
  if (key === "monitor_carrier_review") return "Sync carrier status";
  if (key === "enable_text_back") return "Review text-back";
  return "Review billing";
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
  const callsControlOpen =
    primaryDestination === "#calls" ||
    Boolean((notices.number && notices.number !== "assigned") || (notices.calls && notices.calls !== "saved"));
  const textingControlOpen =
    primaryDestination === "#texting" ||
    Boolean(notices.carrier && !carrierMessage?.startsWith("Twilio campaign status synchronized"));
  const blockerControlOpen =
    primaryDestination === "#blocker" ||
    Boolean(notices.blocker && notices.blocker !== "saved");
  const billingControlOpen = Boolean(notices.billing_action && !billingActionSucceeded(notices.billing_action));
  const hasWorkspaceNotice = Boolean(
    kickoffMessage ||
    billingMessage ||
    blockerMessage ||
    carrierMessage ||
    numberMessage ||
    profileMessage ||
    accountControlMessage,
  );
  const callsDetail = opsState.calls === "ready"
    ? `${runtime?.twilioPhoneNumber || "Relay number assigned"} · verified by a real missed call`
    : opsState.calls === "waiting_for_forwarding"
      ? `${runtime?.twilioPhoneNumber || "Relay number assigned"} · forwarding not verified`
      : opsState.calls === "paused"
        ? "Call setup is on hold"
        : runtime?.twilioPhoneNumber
          ? `${runtime.twilioPhoneNumber} · waiting for a verified missed call`
          : "Relay number not assigned";
  const textingDetail = carrierProfile?.statusDetail ||
    (opsState.texting === "approved"
      ? summary.smsEnabled ? "Automatic text-back is on" : "Approved · automatic text-back is off"
      : opsState.texting === "carrier_review"
        ? "Carrier review is in progress"
        : opsState.texting === "issue"
          ? "Review the latest carrier response"
          : "Registration has not been submitted");
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

        <div className="ops-account-workspace__head">
          <div>
            <Link className="ops-account-workspace__back" href="/ops">
              <Icon name="arrowLeft" size={14} /> Work queue
            </Link>
            <h1 className="t-display">{summary.businessName}</h1>
            <p>{runtime?.ownerName || "Owner not set"}{summary.ownerEmail ? ` · ${summary.ownerEmail}` : ""}</p>
          </div>
          <span className={`lead-card__status-pill lead-card__status-pill--${queuePillTone}`}>{opsState.queueLabel}</span>
        </div>

        {hasWorkspaceNotice ? (
          <div className="ops-workspace-notices" aria-live="polite">
            {kickoffMessage ? <div className={notices.kickoff === "failed" ? "intake-error settings-notice" : "settings-notice"}>{kickoffMessage}</div> : null}
            {billingMessage ? <div className={billingActionSucceeded(notices.billing_action) ? "settings-notice" : "intake-error settings-notice"}>{billingMessage}</div> : null}
            {blockerMessage ? <div className={notices.blocker === "saved" ? "settings-notice" : "intake-error settings-notice"}>{blockerMessage}</div> : null}
            {carrierMessage ? <div className={notices.carrier === "sync_failed" || notices.carrier === "invalid_ids" || notices.carrier === "unknown_status" || notices.carrier === "save_failed" ? "intake-error settings-notice" : "settings-notice"}>{carrierMessage}</div> : null}
            {numberMessage ? <div className={notices.number === "assigned" ? "settings-notice" : "intake-error settings-notice"}>{numberMessage}</div> : null}
            {profileMessage ? <div className={notices.profile === "saved" ? "settings-notice" : "intake-error settings-notice"}>{profileMessage}</div> : null}
            {accountControlMessage ? <div className={notices.calls === "saved" ? "settings-notice" : "intake-error settings-notice"}>{accountControlMessage}</div> : null}
          </div>
        ) : null}

        <dl className="ops-workspace-status" aria-label="Independent account statuses">
          <div className={opsState.calls === "ready" ? "ops-workspace-status__good" : undefined}>
            <dt>Calls</dt><dd>{opsState.labels.calls}</dd>
          </div>
          <div className={opsState.texting === "approved" ? "ops-workspace-status__good" : undefined}>
            <dt>Texting</dt><dd>{opsState.labels.texting}</dd>
          </div>
          <div className={opsState.billing === "attention" ? "ops-workspace-status__attention" : undefined}>
            <dt>Billing</dt><dd>{opsState.labels.billing}</dd>
          </div>
          <div className={opsState.blockedBy === "none" ? undefined : "ops-workspace-status__attention"}>
              <dt>Blocked by</dt>
              <dd>{opsState.labels.blocker}{opsState.blockedAgeDays !== null ? ` · ${opsState.blockedAgeDays}d` : ""}</dd>
          </div>
        </dl>

        <section className="panel ops-workspace-primary" aria-label="Primary operator action">
          <div className="ops-workspace-primary__copy">
            <span className="ops-workspace-primary__label">Next step</span>
            <div>
              <h2>{opsState.nextAction.label}</h2>
              <p>{opsState.nextAction.detail}</p>
            </div>
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
              {nextActionButtonLabel(opsState.nextAction.key)}
            </Link>
          ) : null}
        </section>

        <div className="ops-workspace-layout">
          <section className="panel ops-task-list" id="setup" aria-label="Setup">
            <header className="ops-card-heading">
              <div>
                <p className="t-eyebrow">Setup</p>
                <h2>Service readiness</h2>
              </div>
              <span>Open a row to make changes</span>
            </header>

            <details className="ops-task-row" id="calls" open={callsControlOpen}>
              <summary>
                <span className={`ops-task-row__icon ${opsState.calls === "ready" ? "ops-task-row__icon--good" : ""}`}><Icon name="phone" size={17} /></span>
                <span className="ops-task-row__content">
                  <span className="ops-task-row__label">Calls</span>
                  <strong>{opsState.labels.calls}</strong>
                  <small>{callsDetail}</small>
                </span>
                <span className="ops-task-row__action">{runtime?.twilioPhoneNumber ? "Manage" : "Assign number"} <Icon name="chevronRight" size={15} /></span>
              </summary>
              {operator.role !== "support" ? (
                <div className="ops-task-row__body">
                  <form action="/api/ops/twilio/assign" method="post" className="ops-compact-form">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <div>
                      <strong>Relay number</strong>
                      <p>Attach a number already owned in the configured Twilio account.</p>
                    </div>
                    <div className="ops-inline-control">
                      <input className="field" name="phone_number" required pattern="\+1[0-9]{10}" placeholder="+12065550123" aria-label="Twilio phone number" />
                      <button className="btn btn-secondary" name="action" value="attach_existing">Attach number</button>
                    </div>
                  </form>
                  <form action="/api/ops/calls" method="post" className="ops-compact-form">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <div>
                      <strong>Onboarding hold</strong>
                      <p>Pause or resume setup without changing Stripe.</p>
                    </div>
                    <div className="ops-inline-control">
                      <select className="field" name="account_control" defaultValue="" aria-label="Set explicit onboarding hold">
                        <option value="" disabled>Choose action…</option>
                        <option value="resume_onboarding">Resume onboarding</option>
                        <option value="pause_onboarding">Pause onboarding</option>
                      </select>
                      <button className="btn btn-secondary" type="submit">Apply</button>
                    </div>
                  </form>
                </div>
              ) : <p className="ops-task-row__readonly">Support access is read-only.</p>}
            </details>

            <details className="ops-task-row" id="texting" open={textingControlOpen}>
              <summary>
                <span className={`ops-task-row__icon ${opsState.texting === "approved" ? "ops-task-row__icon--good" : ""}`}><Icon name="message" size={17} /></span>
                <span className="ops-task-row__content">
                  <span className="ops-task-row__label">Texting</span>
                  <strong>{opsState.labels.texting}</strong>
                  <small>{textingDetail}</small>
                </span>
                <span className="ops-task-row__action">Sync A2P <Icon name="chevronRight" size={15} /></span>
              </summary>
              {operator.role !== "support" ? (
                <form action="/api/ops/carrier" method="post" className="ops-task-row__body ops-compact-form">
                  <input type="hidden" name="account_slug" value={summary.accountSlug} />
                  <div>
                    <strong>Twilio campaign</strong>
                    <p>Registration happens in Twilio. Relay reads the result; an operator cannot mark A2P approved.</p>
                  </div>
                  <label className="form-field">
                    <span className="field-label">Messaging Service SID</span>
                    <input className="field" name="messaging_service_sid" required pattern="MG[0-9a-fA-F]{32}" defaultValue={carrierProfile?.messagingServiceSid ?? ""} placeholder="MG…" />
                  </label>
                  <label className="form-field">
                    <span className="field-label">A2P Campaign SID</span>
                    <input className="field" name="twilio_campaign_sid" required pattern="QE[0-9a-fA-F]{32}" defaultValue={carrierProfile?.twilioCampaignSid ?? ""} placeholder="QE…" />
                  </label>
                  <button className="btn btn-secondary" type="submit">Sync status</button>
                </form>
              ) : <p className="ops-task-row__readonly">Support access is read-only.</p>}
            </details>

            <details className={`ops-task-row ${opsState.blockedBy !== "none" ? "ops-task-row--attention" : "ops-task-row--quiet"}`} id="blocker" open={blockerControlOpen}>
              <summary>
                <span className="ops-task-row__icon"><Icon name="pause" size={17} /></span>
                <span className="ops-task-row__content">
                  <span className="ops-task-row__label">Blocker</span>
                  <strong>{opsState.blockedBy === "none" ? "—" : `${opsState.labels.blocker}${opsState.blockedAgeDays !== null ? ` · ${opsState.blockedAgeDays}d` : ""}`}</strong>
                  {opsState.blockerNote ? <small>{opsState.blockerNote}</small> : null}
                </span>
                <span className="ops-task-row__action">{opsState.blockedBy === "none" ? "Add blocker" : "Update"} <Icon name="chevronRight" size={15} /></span>
              </summary>
              {operator.role !== "support" ? (
                <form action="/api/ops/blocker" method="post" className="ops-task-row__body ops-compact-form">
                  <input type="hidden" name="account_slug" value={summary.accountSlug} />
                  <label className="form-field">
                    <span className="field-label">Blocked by</span>
                    <select className="field" name="blocked_by" defaultValue={opsState.blockedBy}>
                      <option value="none">Nobody</option>
                      <option value="relay">Relay</option>
                      <option value="customer">Customer</option>
                      <option value="carrier">Carrier</option>
                    </select>
                  </label>
                  <label className="form-field">
                    <span className="field-label">What is needed?</span>
                    <input className="field" name="note" minLength={5} maxLength={240} defaultValue={opsState.blockerNote ?? ""} placeholder="Required when a blocker is selected" />
                  </label>
                  <button className="btn btn-secondary" type="submit">Save blocker</button>
                </form>
              ) : <p className="ops-task-row__readonly">Support access is read-only.</p>}
            </details>
          </section>

          <aside className="ops-workspace-sidebar">
            <section className="panel ops-billing-card" id="billing" aria-label="Billing">
              <header className="ops-card-heading">
                <div>
                  <p className="t-eyebrow">Billing</p>
                  <h2>{opsState.labels.billing}</h2>
                </div>
                {monthlyTone === "warn" ? <span className="chip chip-danger">Attention</span> : null}
              </header>
              <dl className="ops-billing-ledger">
                <div>
                  <dt>Setup fee</dt>
                  <dd>{kickoffState}</dd>
                  <small>{isFoundingPilot ? "Founding pilot" : "$150 standard setup"}</small>
                </div>
                <div>
                  <dt>Payment method</dt>
                  <dd>{billing.stripeDefaultPaymentMethodId ? "Ready" : "Needed"}</dd>
                  <small>Stored securely by Stripe</small>
                </div>
                <div>
                  <dt>Monthly</dt>
                  <dd>{monthlyState}</dd>
                  <small>{effectiveBillingStatus === "not_started" ? `${isFoundingPilot ? "30" : "14"}-day trial starts after activation` : "$99 per month"}</small>
                </div>
              </dl>

              {operator.role !== "support" ? (
                <details className="ops-secondary-menu" open={billingControlOpen}>
                  <summary>More billing actions <Icon name="chevronRight" size={15} /></summary>
                  <div className="ops-secondary-menu__body">
                    {(pilotCardNeeded || kickoffCollectible) && opsState.nextAction.key !== "complete_setup_payment" && opsState.nextAction.key !== "collect_payment_method" ? (
                      <form action="/api/ops/kickoff" method="post">
                        <input type="hidden" name="account_slug" value={summary.accountSlug} />
                        <button className="btn btn-secondary" name="action" value="send_invoice">
                          {pilotCardNeeded ? "Email secure card link" : billing.setupFeeStatus === "due" ? "Email $150 payment link" : "Collect $150 again"}
                        </button>
                      </form>
                    ) : null}
                    <form action="/api/ops/billing/reconcile" method="post">
                      <input type="hidden" name="account_slug" value={summary.accountSlug} />
                      <button className="btn btn-secondary" type="submit">Sync with Stripe</button>
                    </form>
                    {(billing.setupFeeStatus === "paid" || billing.setupFeeStatus === "partially_refunded") && operator.role === "super_admin" && stripePaymentUrl ? (
                      <a className="btn btn-secondary" href={stripePaymentUrl} target="_blank" rel="noreferrer">Open payment in Stripe</a>
                    ) : null}

                    {operator.role === "super_admin" ? (
                      <div className="ops-commercial-exceptions">
                        <strong>Super-admin commercial exceptions</strong>
                        <p>Every exception requires a reason and confirmation.</p>
                        {!canApplyOverride ? <p className="intake-error settings-notice">Locked while Stripe has a live subscription.</p> : null}
                        <form action="/api/ops/billing" method="post" className="ops-compact-form">
                          <input type="hidden" name="account_slug" value={summary.accountSlug} />
                          <label className="form-field"><span className="field-label">Reason</span><input className="field" name="reason" maxLength={240} minLength={5} required placeholder="Why is this exception appropriate?" /></label>
                          <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm exception</label>
                          <div className="ops-billing-actions" aria-label="Manual billing actions">
                            <button className="btn btn-secondary" type="submit" name="action" value="comp" disabled={!canApplyOverride}>Comp account</button>
                            <button className="btn btn-secondary" type="submit" name="action" value="uncomp" disabled={!canApplyOverride}>Remove comp</button>
                          </div>
                        </form>
                        {canApplyOverride && !kickoffSettled ? (
                          <form action="/api/ops/billing" method="post" className="ops-compact-form">
                            <input type="hidden" name="account_slug" value={summary.accountSlug} />
                            <label className="form-field"><span className="field-label">Waiver reason</span><input className="field" name="reason" maxLength={240} minLength={5} required placeholder="e.g. founding pilot" /></label>
                            <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm waiver</label>
                            <button className="btn btn-secondary" type="submit" name="action" value="waive_setup_fee">Make founding pilot</button>
                          </form>
                        ) : null}
                        {billing.setupFeeStatus === "waived" && canApplyOverride ? (
                          <form action="/api/ops/billing" method="post" className="ops-compact-form">
                            <input type="hidden" name="account_slug" value={summary.accountSlug} />
                            <label className="form-field"><span className="field-label">Reason to require setup fee</span><input className="field" name="reason" maxLength={240} minLength={5} required /></label>
                            <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm standard terms</label>
                            <button className="btn btn-secondary" type="submit" name="action" value="require_setup_fee">Return to standard terms</button>
                          </form>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
              <p className="ops-billing-card__foot">Charges, refunds, payment methods, and cancellation are managed in Stripe.</p>
            </section>
          </aside>
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

import Link from "next/link";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { Icon } from "@/components/icon";
import { requirePlatformOperator } from "@/lib/auth";
import { canApplyOperatorBillingOverride, isSetupFeeSettled } from "@/lib/billing";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  deriveOpsState,
  type OpsNextActionKey,
} from "@/lib/ops-state";
import { loadAccountOnboardingReadiness } from "@/lib/onboarding-readiness";
import { stripeDashboardPaymentUrl } from "@/lib/stripe-billing";
import {
  getOpsAccountBySlug,
  getOpsBillingAccountBySlug,
  getRecentStripeEventsForAccount,
  getRecentWebhookEventsForAccount,
  getCarrierProfile,
  listProviderActionsForAccount,
  recordPlatformAuditEvent,
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
  if (status === "card_link_sent") return "Secure no-charge Stripe card link emailed to the customer. The $150 setup fee will not be charged again.";
  if (status === "failed") return "Kickoff action failed. No billing state was changed unless shown above.";
  if (status === "owner_email_missing") return "Add the customer's email before sending a secure billing link.";
  if (status === "already_ready") return "Stripe already has the required setup payment or waiver and a saved payment method.";
  if (status === "account_comped") return "This account has free access; no card, setup payment, or Stripe subscription is needed.";
  if (status === "commercial_terms_incomplete") return "Complete and audit the founding-pilot setup-fee waiver before collecting a card.";
  return "Kickoff action received.";
}

function billingActionNotice(status: string | undefined) {
  if (!status) return null;
  if (status === "comp") return "Free pilot access saved. No setup payment, card, or Stripe subscription is required, and the optional review date cannot trigger a charge.";
  if (status === "uncomp") return "Free access ended. No charge was created; paid terms still require an explicit Stripe setup.";
  if (status === "waive_setup_fee") return "The $150 setup fee was waived and recorded.";
  if (status === "require_setup_fee") return "The $150 setup fee is required.";
  if (status === "reason_required") return "Add a meaningful reason (at least five characters) before changing billing policy.";
  if (status === "review_date_invalid") return "Choose a valid future review date or leave it blank.";
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
  if (status === "account_comped") return "No Stripe trial was started because this account has free access.";
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
  if (key === "resolve_billing" || key === "review_cancellation" || key === "review_canceled_subscription" || key === "review_free_access") return "#billing";
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
    onboarding_test?: string;
    evidence?: string;
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

  // Account workspaces expose customer contact, billing, and provider evidence.
  // Fail closed if the sensitive support read cannot be durably audited.
  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    targetAccountId: billing.accountId,
    action: OPS_ACTIONS.accountRead,
    summary: "Viewed Operations account workspace",
  }, { required: true });

  const isComped = billing.billingPolicy === "comped";
  const isFoundingPilot = billing.commercialOffer === "founding_pilot";
  const setupFeeWaived = billing.billingPolicy === "setup_fee_waived" || isFoundingPilot;
  const effectiveBillingStatus = isComped ? "comped" : billing.billingStatus;

  const [stripeEvents, systemEvents, carrierProfile, onboarding, providerActions] = await Promise.all([
    getRecentStripeEventsForAccount(billing.accountId, 25),
    getRecentWebhookEventsForAccount(billing.accountId, 25),
    getCarrierProfile(billing.accountId),
    loadAccountOnboardingReadiness(billing.accountId),
    listProviderActionsForAccount(billing.accountId, 50),
  ]);
  const runtime = onboarding.runtime;
  const opsState = deriveOpsState({
    technicalStatus: onboarding.facts.technicalStatus,
    a2pStatus: summary.a2pStatus,
    smsEnabled: summary.smsEnabled,
    billingStatus: effectiveBillingStatus,
    billingPolicy: billing.billingPolicy,
    freeAccessReviewAt: billing.freeAccessReviewAt,
    stripeSubscriptionStatus: billing.stripeSubscriptionStatus,
    setupFeeStatus: billing.setupFeeStatus,
    stripeDefaultPaymentMethodId: billing.stripeDefaultPaymentMethodId,
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    blockedBy: summary.opsBlockedBy,
    blockerNote: summary.opsBlockerNote,
    blockedSince: summary.opsBlockedSince,
  });
  const failedCount = providerActions.filter((event) => event.internalStatus === "failed").length;

  const canApplyOverride = canApplyOperatorBillingOverride(billing);
  // Kickoff state, spelled out before any buttons.
  const kickoffSettled = isSetupFeeSettled(
    billing.setupFeeStatus,
    billing.firstPaidAt,
    billing.billingPolicy,
  );
  const kickoffCollectible = !kickoffSettled && (billing.setupFeeStatus === "due" || billing.setupFeeStatus === "refunded" ||
    billing.setupFeeStatus === "charged_back");
  const cardCollectionNeeded =
    kickoffSettled &&
    !isComped &&
    !billing.stripeDefaultPaymentMethodId &&
    effectiveBillingStatus !== "active" &&
    effectiveBillingStatus !== "trialing";
  const kickoffState = isComped
    ? billing.setupFeeStatus === "paid" || billing.setupFeeStatus === "partially_refunded"
      ? billing.setupFeeStatus === "paid" ? "Paid" : "Partially refunded"
      : "Waived for free access"
    : billing.setupFeeStatus === "paid"
    ? "Paid"
    : setupFeeWaived
      ? "Waived by policy"
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
          ? opsState.freeAccessReviewAt
            ? `Free access — review ${formatDate(opsState.freeAccessReviewAt)}`
            : "Free access — no Stripe subscription"
          : effectiveBillingStatus === "past_due"
            ? "Past due — payment failed"
            : effectiveBillingStatus === "canceled"
              ? "Canceled"
              : "Not started";
  const monthlyTone = effectiveBillingStatus === "past_due" ? "warn" : "neutral";
  const freeReviewInputValue = billing.freeAccessReviewAt?.slice(0, 10) ?? "";
  const stripePaymentUrl = billing.setupFeePaymentIntentId
    ? stripeDashboardPaymentUrl(billing.setupFeePaymentIntentId)
    : null;
  const kickoffMessage = kickoffNotice(notices.kickoff, isFoundingPilot);
  const billingMessage = billingActionNotice(notices.billing_action);
  const blockerMessage = blockerNotice(notices.blocker);
  const accountControlMessage = accountControlNotice(notices.calls);
  const onboardingTestMessage = notices.onboarding_test === "sent"
    ? "Owner notification test sent. Ask the owner to confirm receipt from Setup."
    : notices.onboarding_test === "skipped"
      ? "Owner notification test was not sent. Check the recipient and Resend configuration."
      : notices.onboarding_test === "failed"
        ? "Owner notification provider rejected the test. Check Diagnostics before retrying."
        : null;
  const carrierMessage = carrierNotice(notices.carrier);
  const numberMessage = notices.number === "assigned"
    ? "Relay number assigned and configured."
    : notices.number === "released"
      ? "Relay number detached from this closed account. It remains in Twilio and can now be assigned elsewhere."
      : notices.number === "none"
        ? "No Relay number mapping was attached to this account."
        : notices.number === "release_requires_closed"
          ? "Close the account before detaching its Relay number. This protects active call routing."
          : notices.number === "reason_required"
            ? "Add a meaningful reason (at least five characters) before detaching the number."
            : notices.number === "confirmation_required"
              ? "Confirm the number detachment before applying it."
              : notices.number === "release_failed"
                ? "Number detachment failed. The account mapping was not changed."
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
  const onboardingAction = onboarding.readiness.operatorAction;
  const setupActionActive = onboardingAction.owner !== "none";
  const primaryAction = setupActionActive ? onboardingAction : opsState.nextAction;
  const primaryDestination = setupActionActive
    ? onboardingAction.href
    : nextActionDestination(opsState.nextAction.key);
  const callsControlOpen =
    primaryDestination === "#calls" ||
    Boolean((notices.number && notices.number !== "assigned" && notices.number !== "released" && notices.number !== "none") || (notices.calls && notices.calls !== "saved"));
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
    accountControlMessage ||
    onboardingTestMessage
  );
  const businessHoursSummary = typeof runtime.businessHours?.summary === "string"
    ? runtime.businessHours.summary
    : "";
  const relayA2pStatus = summary.a2pStatus || "not_started";
  const carrierLastSynced = carrierProfile?.updatedAt
    ? formatDateTime(carrierProfile.updatedAt)
    : "Never";
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
            {onboardingTestMessage ? <div className={notices.onboarding_test === "sent" ? "settings-notice" : "intake-error settings-notice"}>{onboardingTestMessage}</div> : null}
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
              <h2>{primaryAction.label}</h2>
              <p>{primaryAction.detail}</p>
            </div>
          </div>
          {setupActionActive && onboardingAction.href ? (
            <Link className="btn btn-primary" href={onboardingAction.href}>
              Open onboarding step
            </Link>
          ) : operator.role !== "support" && opsState.nextAction.key === "check_trial_activation" ? (
            <form action="/api/ops/billing/activate" method="post">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <button className="btn btn-primary" type="submit">Start eligible Stripe trial</button>
            </form>
          ) : operator.role !== "support" && (opsState.nextAction.key === "complete_setup_payment" || opsState.nextAction.key === "collect_payment_method") ? (
            <form action="/api/ops/kickoff" method="post">
              <input type="hidden" name="account_slug" value={summary.accountSlug} />
              <button className="btn btn-primary" name="action" value="send_invoice">
                {opsState.nextAction.key === "collect_payment_method" ? "Send no-charge card link" : "Send $150 payment link"}
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
                  {operator.role === "super_admin" && runtime?.twilioPhoneNumber && summary.accountStatus === "archived" && summary.technicalStatus === "closed" ? (
                    <form action="/api/ops/twilio/release" method="post" className="ops-compact-form">
                      <input type="hidden" name="account_slug" value={summary.accountSlug} />
                      <div>
                        <strong>Detach this Relay number</strong>
                        <p>Use after closing the account. This removes the account mapping; the number stays in Twilio for another account.</p>
                      </div>
                      <label className="form-field"><span className="field-label">Reason</span><input className="field" name="reason" minLength={5} maxLength={240} required placeholder="e.g. reassigning pilot number" /></label>
                      <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm forwarding and text-back are disabled for this account.</label>
                      <button className="btn btn-secondary" type="submit">Detach number</button>
                    </form>
                  ) : null}
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
                    <p><strong>Relay status:</strong> {relayA2pStatus.replaceAll("_", " ")}</p>
                    <p><strong>Twilio profile:</strong> {(carrierProfile?.status ?? "not synced").replaceAll("_", " ")}</p>
                    <p><strong>Last Twilio sync:</strong> {carrierLastSynced}</p>
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

            <details className="ops-task-row ops-task-row--quiet" id="onboarding" open={primaryDestination === "#onboarding" || Boolean(notices.onboarding_test)}>
              <summary>
                <span className={`ops-task-row__icon ${onboarding.facts.ownerNotificationConfirmedAt ? "ops-task-row__icon--good" : ""}`}><Icon name="sparkle" size={17} /></span>
                <span className="ops-task-row__content">
                  <span className="ops-task-row__label">Handoff checks</span>
                  <strong>{onboarding.facts.ownerNotificationConfirmedAt ? "Owner email confirmed" : onboarding.facts.ownerNotificationSentAt ? "Awaiting owner confirmation" : "Owner email not tested"}</strong>
                  <small>Send and verify the owner notification before handoff.</small>
                </span>
                <span className="ops-task-row__action">Run checks <Icon name="chevronRight" size={15} /></span>
              </summary>
              {operator.role !== "support" ? (
                <div className="ops-task-row__body ops-compact-form">
                  <form action="/api/email-test/start" method="post" className="ops-compact-form">
                    <input type="hidden" name="account_slug" value={summary.accountSlug} />
                    <input type="hidden" name="return_to" value="ops_onboarding" />
                    <div>
                      <strong>Owner notification test</strong>
                      <p>{onboarding.facts.ownerNotificationSentAt ? `Last sent ${formatDateTime(onboarding.facts.ownerNotificationSentAt)}. The owner must confirm receipt from Setup.` : "Send the existing audited test to the configured owner email, then ask the owner to confirm receipt from Setup."}</p>
                    </div>
                    <button className="btn btn-secondary" type="submit">Send owner email test</button>
                  </form>
                </div>
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
                  <small>{isComped ? "No setup charge for free access" : isFoundingPilot ? "Founding pilot" : "$150 standard setup"}</small>
                </div>
                <div>
                  <dt>Payment method</dt>
                  <dd>{isComped ? "Not required" : billing.stripeDefaultPaymentMethodId ? "Ready" : "Needed"}</dd>
                  <small>{isComped ? "No card needed for free access" : "Stored securely by Stripe"}</small>
                </div>
                <div>
                  <dt>Monthly</dt>
                  <dd>{monthlyState}</dd>
                  <small>{isComped
                    ? "No subscription or automatic charges"
                    : effectiveBillingStatus === "not_started"
                      ? `${isFoundingPilot ? "30" : "14"}-day trial starts after activation`
                      : "$99 per month"}</small>
                </div>
              </dl>

              {operator.role !== "support" ? (
                <details className="ops-secondary-menu" open={billingControlOpen}>
                  <summary>More billing actions <Icon name="chevronRight" size={15} /></summary>
                  <div className="ops-secondary-menu__body">
                    {(cardCollectionNeeded || kickoffCollectible) && opsState.nextAction.key !== "complete_setup_payment" && opsState.nextAction.key !== "collect_payment_method" ? (
                      <form action="/api/ops/kickoff" method="post">
                        <input type="hidden" name="account_slug" value={summary.accountSlug} />
                        <button className="btn btn-secondary" name="action" value="send_invoice">
                          {cardCollectionNeeded ? "Send no-charge card link" : "Send $150 payment link"}
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
                          <div>
                            <strong>Free pilot access</strong>
                            <p>No setup payment, card, trial, or subscription. The optional review date is a reminder only.</p>
                          </div>
                          <label className="form-field">
                            <span className="field-label">Review date (optional)</span>
                            <input className="field" type="date" name="free_access_review_at" defaultValue={freeReviewInputValue} />
                          </label>
                          <label className="form-field"><span className="field-label">Reason</span><input className="field" name="reason" maxLength={240} minLength={5} required placeholder="e.g. early product pilot" /></label>
                          <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm: no setup charge, card, or subscription will be created.</label>
                          <div className="ops-billing-actions" aria-label="Manual billing actions">
                            <button className="btn btn-secondary" type="submit" name="action" value="comp" disabled={!canApplyOverride}>
                              {isComped ? "Update free access" : "Start free access"}
                            </button>
                          </div>
                        </form>
                        {isComped ? (
                          <form action="/api/ops/billing" method="post" className="ops-compact-form">
                            <input type="hidden" name="account_slug" value={summary.accountSlug} />
                            <label className="form-field"><span className="field-label">Reason to end free access</span><input className="field" name="reason" maxLength={240} minLength={5} required /></label>
                            <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm: ending free access creates no charge; paid terms still require Stripe setup.</label>
                            <button className="btn btn-secondary" type="submit" name="action" value="uncomp" disabled={!canApplyOverride}>End free access</button>
                          </form>
                        ) : null}
                        {canApplyOverride && !kickoffSettled ? (
                          <form action="/api/ops/billing" method="post" className="ops-compact-form">
                            <input type="hidden" name="account_slug" value={summary.accountSlug} />
                            <div>
                              <strong>Setup-fee waiver only</strong>
                              <p>Use for a paid pilot: the card is still required and the 30-day trial waits for activation.</p>
                            </div>
                            <label className="form-field"><span className="field-label">Waiver reason</span><input className="field" name="reason" maxLength={240} minLength={5} required placeholder="e.g. paid founding pilot" /></label>
                            <label><input type="checkbox" name="confirmation" value="confirmed" required /> Confirm setup-fee waiver only</label>
                            <button className="btn btn-secondary" type="submit" name="action" value="waive_setup_fee">Waive setup fee</button>
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

        <details className="panel setup-panel ops-customer-details" id="customer-details" open={primaryDestination === "#customer-details" || Boolean(notices.profile && notices.profile !== "saved")}>
          <summary>
            <span><strong>Call setup</strong><small>The few details Relay needs to cover missed calls</small></span>
          </summary>
          <div className="ops-customer-details__body">
            <dl className="ops-workspace-facts">
              <div><dt>Business</dt><dd>{runtime?.businessName || summary.businessName}</dd></div>
              <div><dt>Owner</dt><dd>{runtime?.ownerName || "Not set"}</dd></div>
              <div><dt>Owner email</dt><dd>{runtime?.ownerEmail || summary.ownerEmail || "Not set"}</dd></div>
              <div><dt>Public number</dt><dd>{runtime?.publicBusinessNumber || "Not set"}</dd></div>
              <div><dt>Relay number</dt><dd>{runtime?.twilioPhoneNumber || "Not assigned"}</dd></div>
              <div><dt>How it works</dt><dd>{runtime?.callMode === "direct" ? "Calls ring the owner first" : "Relay answers missed calls"}</dd></div>
            </dl>
            {operator.role !== "support" ? (
              <form action="/api/ops/profile" method="post" className="setup-panel__action ops-form">
                <input type="hidden" name="account_slug" value={summary.accountSlug} />
                <div className="ops-form__intro">
                  <p className="t-eyebrow">Essentials</p>
                  <p>For forwarding, the customer&apos;s phone rings normally. Relay answers only after the call is missed.</p>
                </div>
                <label className="form-field"><span className="form-field__label">Business name</span><input className="field" name="business_name" required defaultValue={runtime?.businessName ?? summary.businessName} /></label>
                <label className="form-field"><span className="form-field__label">Owner name</span><input className="field" name="owner_name" required defaultValue={runtime?.ownerName ?? ""} /></label>
                <label className="form-field"><span className="form-field__label">Owner email</span><input className="field" type="email" name="owner_email" required defaultValue={runtime?.ownerEmail ?? summary.ownerEmail ?? ""} /></label>
                <label className="form-field"><span className="form-field__label">Current business number</span><input className="field" name="public_business_number" required={runtime?.callMode !== "direct"} defaultValue={runtime?.publicBusinessNumber ?? ""} /><small className="form-field__hint">The number customers already call.</small></label>
                <label className="form-field"><span className="form-field__label">Voicemail greeting <small>Optional</small></span><textarea className="field" name="missed_call_voice_message" defaultValue={runtime?.missedCallVoiceMessage ?? ""} placeholder={`Thanks for calling ${runtime?.businessName || summary.businessName}. Sorry we missed you. Please leave a message after the tone.`} /><small className="form-field__hint">Leave blank to use Relay&apos;s standard greeting. The customer can record one later.</small></label>

                <details className="ops-advanced-fields">
                  <summary>Optional and advanced settings</summary>
                  <div className="ops-advanced-fields__body">
                    <label className="form-field"><span className="form-field__label">Owner mobile</span><input className="field" name="owner_phone_number" defaultValue={runtime?.ownerPhoneNumber ?? ""} /><small className="form-field__hint">Needed only for owner SMS alerts or direct-call mode.</small></label>
                    <label className="form-field"><span className="form-field__label">Call mode</span><select className="field" name="call_mode" defaultValue={runtime?.callMode ?? "forwarding"}><option value="forwarding">Missed-call forwarding</option><option value="direct">Relay number is public</option></select></label>
                    <label className="form-field"><span className="form-field__label">Forwarding carrier</span><input className="field" name="forwarding_carrier" defaultValue={runtime?.forwardingCarrier ?? ""} placeholder="Optional — used only for tailored instructions" /></label>
                    <label className="form-field"><span className="form-field__label">Legal business name</span><input className="field" name="legal_business_name" defaultValue={runtime?.legalBusinessName ?? ""} /><small className="form-field__hint">Keep A2P registration details in Twilio; this is optional account reference.</small></label>
                    <label className="form-field"><span className="form-field__label">Business type</span><input className="field" name="business_type" defaultValue={runtime?.businessType ?? ""} placeholder="Optional" /></label>
                    <label className="form-field"><span className="form-field__label">Scheduling link</span><input className="field" name="scheduling_url" defaultValue={runtime?.schedulingUrl ?? ""} placeholder="Optional — https://…" /></label>
                    <label className="form-field"><span className="form-field__label">Custom missed-call text</span><textarea className="field" name="sms_template" defaultValue={runtime?.smsTemplate ?? ""} placeholder="Optional — Relay uses the standard approved message by default." /><small className="form-field__hint">Used only after A2P approval and automatic text-back activation.</small></label>
                    <label className="form-field"><span className="form-field__label">Business hours</span><textarea className="field" name="business_hours_summary" defaultValue={businessHoursSummary} placeholder="e.g. Mon–Fri 8am–5pm" /><small className="form-field__hint">Used for lead handling and approved customer messaging in either call mode.</small></label>
                    <label className="form-field"><span className="form-field__label">Missed-call coverage expectations</span><textarea className="field" name="coverage_expectations" defaultValue={runtime?.coverageExpectations ?? ""} placeholder="e.g. Capture every unanswered call, including after hours" /><small className="form-field__hint">Record what Relay should cover; forwarding behavior remains controlled by the customer&apos;s carrier.</small></label>
                    {runtime?.callMode === "direct" ? (
                      <label className="form-field"><span className="form-field__label">Ring owner for</span><input className="field" name="dial_timeout_seconds" type="number" min={5} max={60} defaultValue={runtime?.dialTimeoutSeconds ?? 18} /><small className="form-field__hint">Direct mode only. Relay voicemail starts if the owner does not answer.</small></label>
                    ) : null}
                    <label className="form-field"><span className="form-field__label">Maximum voicemail length</span><input className="field" name="voicemail_max_seconds" type="number" min={10} max={300} defaultValue={runtime?.voicemailMaxSeconds ?? 60} /></label>
                  </div>
                </details>
                <button className="btn btn-primary" type="submit">Save call setup</button>
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
                <div className="setup-panel__action ops-form">
                  <strong>Account data</strong>
                  <p>Export first, then run a deletion dry run. Deletion is available only after the account is closed and archived.</p>
                  <a className="btn btn-secondary" href={`/api/ops/accounts/export?account_id=${encodeURIComponent(summary.accountId)}`}>Export account JSON</a>
                  <form action="/api/ops/accounts/delete" method="post">
                    <input type="hidden" name="account_id" value={summary.accountId} />
                    <input type="hidden" name="mode" value="dry_run" />
                    <button className="btn btn-secondary" type="submit">Preview account deletion</button>
                  </form>
                  {summary.accountStatus === "archived" && summary.technicalStatus === "closed" ? (
                    <form action="/api/ops/accounts/delete" method="post" className="ops-compact-form">
                      <input type="hidden" name="account_id" value={summary.accountId} />
                      <input type="hidden" name="mode" value="execute" />
                      <label><input type="checkbox" name="confirmation" value="confirmed" required /> I confirm permanent deletion of this closed tenant and its linked provider content.</label>
                      <button className="btn btn-secondary" type="submit">Delete closed account</button>
                    </form>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </details>

        <details className="panel setup-panel ops-diagnostics" id="diagnostics" open={Boolean(notices.evidence)}>
          <summary>
            Diagnostics
            {failedCount > 0 ? <span className="chip chip-danger">{failedCount} failed</span> : null}
          </summary>
          <div className="ops-diagnostics__body">
            <div className="setup-panel__head">
              <p className="t-eyebrow">Provider actions</p>
              <p className="setup-copy">Standardized recovery evidence. Customer wording is separated from operator diagnostics.</p>
            </div>
            <div className="webhook-events">
              {providerActions.length === 0 ? <p className="empty-copy">No provider actions yet.</p> : providerActions.map((event) => (
                <article className="webhook-event" id={`provider-action-${event.id}`} key={event.id}>
                  <div className="webhook-event__head">
                    <strong>{event.action.replaceAll("_", " ")}</strong>
                    <span>{event.internalStatus} · {formatDateTime(event.lastAttemptAt)}</span>
                  </div>
                  <dl className="webhook-event__meta">
                    <div><dt>Provider</dt><dd>{event.provider} · {event.providerStatus ?? "unknown"}</dd></div>
                    <div><dt>Provider ID</dt><dd>{event.providerIdentifier ?? "none"}</dd></div>
                    <div><dt>Failure code</dt><dd>{event.failureCode ?? "none"}</dd></div>
                    <div><dt>Attempts / retry</dt><dd>{event.attemptCount} · {event.retryEligibility}</dd></div>
                    <div><dt>Customer explanation</dt><dd>{event.customerExplanation}</dd></div>
                    <div><dt>Next action</dt><dd>{event.recommendedNextAction}</dd></div>
                    <div><dt>Diagnostic</dt><dd>{event.diagnosticDetail ?? "none"}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
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

import { Icon } from "@/components/icon";
import { AppHeader } from "@/app/leads/_components/app-header";
import { PageHead } from "@/app/leads/_components/page-head";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { computeBillingLifecycle } from "@/lib/billing";
import type { AccountBillingRecord, BillingLifecycleState } from "@/lib/billing";
import { computeSetupReadiness, type A2pStatus } from "@/lib/readiness";
import {
  getA2pRegistrationStatus,
  getAccountBillingRecord,
  getAccountRecoveryStats,
  getForwardingHealthSummary,
  getLastRecoveredCallAt,
} from "@/lib/supabase";
import { QUICK_REPLIES } from "@/app/leads/_constants";
import { SmsToggle } from "./sms-toggle";

export const dynamic = "force-dynamic";

const A2P_LABELS: Record<string, string> = {
  not_started: "Not started — texting cannot be enabled yet",
  in_progress: "In carrier review — usually takes a few days",
  approved: "Approved — texting is carrier-registered",
  rejected: "Rejected — contact Relay support",
  paused: "Paused",
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="form-field">
      <span className="t-eyebrow form-field__label">{label}</span>
      {children}
      {hint ? <span className="form-field__hint">{hint}</span> : null}
    </label>
  );
}

function formatBillingDate(value: string | null) {
  if (!value) return null;

  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function centsToDollarInput(value: number | null) {
  return value != null && value > 0 ? String(Math.round(value / 100)) : "";
}

function billingStatusLabel(billing: AccountBillingRecord) {
  if (billing.billingStatus === "comped") return "Comped";
  if (billing.billingStatus === "past_due" && !billing.stripeSubscriptionId && billing.trialEndsAt) return "Trial ended";
  if (billing.billingStatus === "past_due") return "Past due";
  if (billing.billingStatus === "canceled") return "Canceled";
  if (billing.cancelAtPeriodEnd) {
    const periodDate = formatBillingDate(billing.currentPeriodEnd);
    return periodDate ? `Active until ${periodDate}` : "Active until period end";
  }
  if (billing.billingStatus === "active") return "Subscription active";
  if (billing.billingStatus === "trialing") return "Trial active";
  return "Not started";
}

function daysUntilBillingDate(value: string | null) {
  if (!value) return null;

  const end = new Date(value);
  if (!Number.isFinite(end.getTime())) return null;

  return Math.ceil((end.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function billingHeadline(billing: AccountBillingRecord, lifecycle: BillingLifecycleState) {
  const periodDate = formatBillingDate(billing.currentPeriodEnd);
  const trialDate = formatBillingDate(billing.trialEndsAt);

  if (billing.cancelAtPeriodEnd && billing.billingStatus === "active") {
    return periodDate ? `Active until ${periodDate}` : "Active until the billing period ends";
  }

  if (billing.billingStatus === "trialing") {
    return trialDate ? `Trial ends ${trialDate}` : "Trial active";
  }

  if (billing.billingStatus === "comped") return "Free account";
  if (billing.billingStatus === "past_due" && !billing.stripeSubscriptionId && billing.trialEndsAt) return "Trial ended";
  if (billing.billingStatus === "past_due") return "Payment needs attention";
  if (billing.billingStatus === "canceled") return "Subscription canceled";
  if (billing.billingStatus === "active") return "Subscription active";
  if (lifecycle.activationReady) return "Ready to start billing";
  return "Finish setup before billing";
}

function billingSummary(billing: AccountBillingRecord, lifecycle: BillingLifecycleState) {
  const periodDate = formatBillingDate(billing.currentPeriodEnd);
  const trialDate = formatBillingDate(billing.trialEndsAt);
  const trialDaysLeft = daysUntilBillingDate(billing.trialEndsAt);

  if (billing.cancelAtPeriodEnd && billing.billingStatus === "active") {
    return periodDate
      ? `Your subscription has been canceled. Relay keeps working until ${periodDate}.`
      : "Your subscription has been canceled. Relay keeps working until the current billing period ends.";
  }

  if (billing.billingStatus === "trialing") {
    if (trialDate && trialDaysLeft !== null && trialDaysLeft > 0) {
      return `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left in your trial. Start billing any time.`;
    }

    if (trialDate) {
      return `Your trial ended ${trialDate}. Start billing to move this account onto a paid subscription.`;
    }

    return "Your trial is active. Start billing any time.";
  }

  if (billing.billingStatus === "comped") {
    return "Relay isn't charging this account.";
  }

  if (billing.billingStatus === "past_due") {
    if (!billing.stripeSubscriptionId && billing.trialEndsAt) {
      return trialDate
        ? `Your trial ended ${trialDate}. Start billing to move this account onto a paid subscription.`
        : "Your trial ended. Start billing to move this account onto a paid subscription.";
    }

    return "Update payment so the subscription stays in good standing.";
  }

  if (billing.billingStatus === "canceled") {
    return lifecycle.activationReady
      ? "Restart the subscription when you're ready to treat this account as paid."
      : "Finish setup before restarting billing.";
  }

  if (billing.setupFeeStatus === "due") {
    return "Pay the one-time $150 setup fee so Relay can finish configuring this account. Monthly billing starts only after A2P approval and activation.";
  }

  return lifecycle.summary;
}

function BillingPrimaryAction({
  billing,
  lifecycle,
  role,
}: {
  billing: AccountBillingRecord;
  lifecycle: BillingLifecycleState;
  role: string;
}) {
  if (lifecycle.ownerAction === "none") {
    return null;
  }

  if (role !== "owner") {
    return <p className="settings-section__meta">Ask the owner to manage billing.</p>;
  }

  if (lifecycle.ownerAction === "finish_setup") {
    return (
      <a className="btn btn-secondary settings-billing__action" href="/setup">
        Finish setup
      </a>
    );
  }

  if (lifecycle.ownerAction === "pay_setup_fee") {
    return (
      <form action="/api/billing/setup-fee" method="post">
        <button className="btn btn-primary settings-billing__action" type="submit">
          Pay $150 setup fee
        </button>
      </form>
    );
  }

  if (billing.billingStatus === "trialing" && !billing.stripeCustomerId) {
    return (
      <form action="/api/billing/checkout" method="post">
        <button className="btn btn-primary settings-billing__action" type="submit">
          Start billing
        </button>
      </form>
    );
  }

  if (billing.billingStatus === "comped") {
    return null;
  }

  if (lifecycle.ownerAction === "start_billing" || lifecycle.ownerAction === "restart_subscription") {
    return (
      <form action="/api/billing/checkout" method="post">
        <button className="btn btn-primary settings-billing__action" type="submit">
          {lifecycle.ownerAction === "restart_subscription" ? "Restart subscription" : "Start billing"}
        </button>
      </form>
    );
  }

  if (lifecycle.ownerAction === "manage_billing" || lifecycle.ownerAction === "update_payment") {
    if (!billing.stripeCustomerId) {
      return <p className="settings-section__meta">Billing needs support because no Stripe customer is attached.</p>;
    }

    return (
      <form action="/api/billing/portal" method="post">
        <button className="btn btn-primary settings-billing__action" type="submit">
          {lifecycle.ownerAction === "update_payment" ? "Update payment" : "Manage billing"}
        </button>
      </form>
    );
  }

  return <p className="settings-section__meta">Contact Relay support to resolve billing.</p>;
}

function BillingSection({
  billing,
  lifecycle,
  role,
}: {
  billing: AccountBillingRecord;
  lifecycle: BillingLifecycleState;
  role: string;
}) {
  const periodDate = formatBillingDate(billing.currentPeriodEnd);
  const trialDate = formatBillingDate(billing.trialEndsAt);
  const guaranteeDate = formatBillingDate(billing.guaranteeEndsAt);
  const periodLabel = billing.cancelAtPeriodEnd ? "Ends" : "Renews";
  const showPaymentWarning = billing.billingStatus === "past_due";
  const showCancelWarning = billing.cancelAtPeriodEnd && billing.billingStatus !== "canceled";
  const setupFeeDate = formatBillingDate(billing.setupFeePaidAt ?? billing.setupFeeWaivedAt);

  return (
    <section id="billing" className="panel settings-section settings-billing">
      <div className="settings-billing__main">
        <div>
          <p className="t-eyebrow settings-section__title">Billing</p>
          <h2 className="settings-billing__plan">Current plan: $99/month</h2>
          <p className="settings-section__lead">{billingHeadline(billing, lifecycle)}</p>
          <p className="settings-section__meta">{billingSummary(billing, lifecycle)}</p>
          {billing.billingStatus !== "active" || billing.cancelAtPeriodEnd ? (
            <p className="settings-section__meta settings-billing__reassurance">
              Missed-call capture is never interrupted by billing.
            </p>
          ) : null}
        </div>
        <BillingPrimaryAction billing={billing} lifecycle={lifecycle} role={role} />
      </div>

      {showPaymentWarning ? (
        <div className="intake-error settings-notice" role="alert">
          <Icon name="alertTriangle" size={14} />
          Your payment didn&apos;t go through. Relay is still catching missed calls while you update your payment method.
        </div>
      ) : null}

      {showCancelWarning ? (
        <div className="panel settings-notice settings-notice--ok" role="status">
          <Icon name="info" size={14} />
          Your subscription has been canceled and will end{periodDate ? ` on ${periodDate}` : " at the end of this billing period"}. Relay keeps working until then.
        </div>
      ) : null}

      <dl className="settings-billing__facts">
        <div>
          <dt>Status</dt>
          <dd>{billingStatusLabel(billing)}</dd>
        </div>
        {periodDate ? (
          <div>
            <dt>{periodLabel}</dt>
            <dd>{periodDate}</dd>
          </div>
        ) : null}
        {trialDate ? (
          <div>
            <dt>Trial ends</dt>
            <dd>{trialDate}</dd>
          </div>
        ) : null}
        {guaranteeDate ? (
          <div>
            <dt>30-day guarantee</dt>
            <dd>Eligible through {guaranteeDate}</dd>
          </div>
        ) : null}
        <div>
          <dt>Setup fee</dt>
          <dd>
            {billing.firstPaidAt
              ? "Settled through prior activation"
              : billing.setupFeeStatus === "paid"
              ? `Paid${setupFeeDate ? ` ${setupFeeDate}` : ""}`
              : billing.setupFeeStatus === "waived"
                ? "Waived"
                : billing.setupFeeStatus === "refunded"
                  ? "Refunded"
                  : "$150 due"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; billing?: string }>;
}) {
  const session = await requireAccountUser();
  const { account, role } = session;
  const params = await searchParams;
  const [a2pStatus, billing, forwardingHealth, recovery, lastRecoveredCallAt] = await Promise.all([
    getA2pRegistrationStatus(session.accountId),
    getAccountBillingRecord(session.accountId),
    getForwardingHealthSummary(session.accountId),
    getAccountRecoveryStats(session.accountId, { since: null }),
    getLastRecoveredCallAt(session.accountId),
  ]);
  const setupReadiness = computeSetupReadiness({
    role,
    hasProfile: Boolean(account.businessName && account.ownerPhoneNumber && account.twilioPhoneNumber),
    callMode: account.callMode,
    smsEnabled: account.smsEnabled,
    a2pStatus: (["not_started", "in_progress", "approved", "rejected", "paused"].includes(a2pStatus ?? "")
      ? a2pStatus
      : "unknown") as A2pStatus,
    forwardingStatus: forwardingHealth.displayStatus,
    hasRecoveredCall: recovery.missedCalls > 0,
    lastRecoveredCallAt,
    forwardingLastPassedAt: forwardingHealth.lastPassedAt,
  });
  const billingLifecycle = computeBillingLifecycle({ billing, setupReadiness });
  const readOnly = role === "viewer";

  return (
    <main className="leads-view">
      <section className="leads-shell settings-shell">
        <AppHeader
          businessName={account.businessName}
          currentPage="settings"
          showOperations={isRelayOperator(session)}
          switchAccountHref={session.membershipCount > 1 ? "/account/select?next=/settings" : undefined}
        />

        <PageHead
          eyebrow="Settings"
          title={account.businessName}
          subtitle={readOnly ? "View-only access" : "Changes apply to the next call that comes in."}
        />

        {params.saved ? (
          <div className="panel settings-notice settings-notice--ok" role="status">
            <Icon name="check" size={14} /> Settings saved.
          </div>
        ) : null}
        {params.error ? (
          <div className="intake-error settings-notice" role="alert">
            <Icon name="alertTriangle" size={14} />
            {params.error === "forbidden"
              ? "Your role does not allow editing settings."
              : params.error === "save_failed"
                ? "Could not save settings. Try again."
                : params.error === "a2p_not_approved"
                  ? "Texting can't be enabled until this account's A2P registration is approved. Update the status with the provisioning script first."
                  : "Please check the highlighted values and try again."}
          </div>
        ) : null}
        {params.billing ? (
          <div className="intake-error settings-notice" role="alert">
            <Icon name="info" size={14} />
            {params.billing === "setup_incomplete"
              ? "Finish call routing and carrier registration before starting billing."
              : params.billing === "already_active"
                ? "This account already has an active subscription. Manage it here instead."
                : params.billing === "past_due" || params.billing === "subscription_incomplete"
                  ? "Update payment in Stripe before changing this subscription."
                  : params.billing === "no_customer"
                    ? "No Stripe customer is attached to this account yet."
                    : params.billing === "forbidden"
                      ? "Only the owner can manage billing."
                      : params.billing === "checkout_failed"
                        ? "Stripe Checkout could not be started. Try again."
                        : params.billing === "portal_failed"
                          ? "Stripe Billing Portal could not be opened. Try again."
                          : params.billing === "setup_fee_required"
                            ? "Pay the one-time setup fee before starting monthly billing."
                            : params.billing === "setup_fee_checkout_failed"
                              ? "Setup-fee Checkout could not be started. Try again."
                              : params.billing === "setup_fee_not_configured"
                                ? "Setup billing is not configured yet. Contact Relay support."
                                : params.billing === "setup_fee_settled"
                                  ? "The setup fee is already paid or waived for this account."
                                  : params.billing === "setup_fee_success"
                                    ? "Setup fee received. Relay will continue setup and start monthly billing only after activation."
                          : "Billing needs support before continuing."}
          </div>
        ) : null}

        <section className="panel settings-section">
          <p className="t-eyebrow settings-section__title">Your Relay line</p>
          <p className="settings-section__lead">
            Relay number: <strong>{account.twilioPhoneNumber}</strong> · Mode: {account.callMode}
          </p>
          <p className="settings-section__meta">
            Carrier registration: {A2P_LABELS[a2pStatus ?? ""] ?? "Unknown"}
          </p>
        </section>

        <BillingSection billing={billing} lifecycle={billingLifecycle} role={role} />

        <form className="panel settings-form" action="/api/settings" method="POST">
          <fieldset disabled={readOnly} className="settings-fieldset">
            <p className="t-eyebrow settings-group-title settings-group-title--first">Business</p>
            <Field label="Business name" hint="Used in texts and voicemail greetings.">
              <input className="field" name="business_name" required maxLength={120} defaultValue={account.businessName} />
            </Field>
            <Field label="Owner phone" hint="Where calls forward and Relay alerts are texted.">
              <input className="field" name="owner_phone_number" required defaultValue={account.ownerPhoneNumber} />
            </Field>
            <Field label="Owner email" hint="Lead notifications and the weekly report.">
              <input className="field" type="email" name="owner_email" defaultValue={account.ownerEmail ?? ""} />
            </Field>
            <Field label="Scheduling link" hint="Optional. Included in texts when set (https://...).">
              <input className="field" name="scheduling_url" defaultValue={account.schedulingUrl ?? ""} />
            </Field>
            <Field
              label="Typical booked job value"
              hint="Optional. Used only to estimate reports when a booked lead is missing a value."
            >
              <div className="money-field">
                <span>$</span>
                <input
                  name="typical_job_value_dollars"
                  type="number"
                  min={0}
                  max={1000000}
                  step={1}
                  inputMode="numeric"
                  defaultValue={centsToDollarInput(account.typicalJobValueCents)}
                  placeholder="250"
                />
              </div>
            </Field>

            <p className="t-eyebrow settings-group-title">Messaging</p>
            {role === "owner" ? <SmsToggle defaultEnabled={account.smsEnabled} /> : null}
            <Field
              label="Missed-call text"
              hint="Sent to callers you miss. Variables: {BUSINESS_NAME}, {INTAKE_URL}, {SCHEDULING_URL}. Leave blank for the default."
            >
              <textarea className="field" name="sms_template" rows={3} maxLength={600} defaultValue={account.smsTemplate ?? ""} placeholder="Hi, this is {BUSINESS_NAME} - sorry we missed your call..." />
            </Field>
            <Field label="Text cooldown (hours)" hint="Never auto-text the same caller twice within this window.">
              <input className="field" type="number" name="missed_call_sms_cooldown_hours" min={1} max={168} required defaultValue={account.missedCallSmsCooldownHours} />
            </Field>
            <Field
              label="Quick replies"
              hint="One per line (up to 6). These are the one-tap replies in the message composer. Leave blank for the defaults. When a scheduling link is set, a 'Send booking link' chip is added automatically."
            >
              <textarea
                className="field"
                name="quick_replies"
                rows={5}
                defaultValue={(account.quickReplyTemplates ?? QUICK_REPLIES).join("\n")}
                placeholder={QUICK_REPLIES.join("\n")}
              />
            </Field>

            <p className="t-eyebrow settings-group-title">Voice</p>
            <Field
              label="Greeting recording URL"
              hint="Optional audio file (https://... .mp3/.wav). When set, this recording plays to callers and the text greeting below is ignored."
            >
              <input className="field" name="missed_call_greeting_audio_url" defaultValue={account.missedCallGreetingAudioUrl ?? ""} placeholder="https://www.relay-nw.com/audio/greeting.mp3" />
            </Field>
            <Field
              label="Voicemail greeting (text-to-speech)"
              hint={account.missedCallGreetingAudioUrl
                ? "Currently unused — your greeting recording above takes precedence."
                : "Spoken to callers before the beep. Leave blank for the default."}
            >
              <textarea className="field" name="missed_call_voice_message" rows={2} maxLength={600} defaultValue={account.missedCallVoiceMessage ?? ""} placeholder="Thanks for calling. Sorry we missed you..." />
            </Field>
            <Field label="Ring time before voicemail (seconds)" hint="How long your phone rings before Relay answers. 5-60.">
              <input className="field" type="number" name="dial_timeout_seconds" min={5} max={60} required defaultValue={account.dialTimeoutSeconds} />
            </Field>
            <Field label="Max voicemail length (seconds)" hint="10-300.">
              <input className="field" type="number" name="voicemail_max_seconds" min={10} max={300} required defaultValue={account.voicemailMaxSeconds} />
            </Field>

            {!readOnly ? (
              <button className="btn btn-primary settings-submit" type="submit">
                Save settings
              </button>
            ) : null}
          </fieldset>
        </form>
      </section>
    </main>
  );
}

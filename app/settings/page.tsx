import { Icon } from "@/components/icon";
import { AppHeader } from "@/app/leads/_components/app-header";
import { PageHead } from "@/app/leads/_components/page-head";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { computeBillingLifecycle } from "@/lib/billing";
import type { AccountBillingRecord, BillingLifecycleState } from "@/lib/billing";
import type { A2pRegistrationStatus } from "@/lib/customer-experience-contract";
import {
  getA2pRegistrationStatus,
  getAccountBillingRecord,
  getAccountTechnicalSetupStatus,
} from "@/lib/supabase";
import { QUICK_REPLIES } from "@/app/leads/_constants";
import { SmsToggle } from "./sms-toggle";
import { GreetingRecorder } from "./greeting-recorder";

export const dynamic = "force-dynamic";

const A2P_LABELS: Record<string, string> = {
  not_started: "Relay is preparing texting",
  in_progress: "Relay is enabling texting",
  approved: "Texting is available",
  needs_attention: "Relay is resolving a texting issue",
  rejected: "Relay is resolving a texting issue",
  paused: "Texting is unavailable",
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
  if (billing.billingPolicy === "comped" || billing.billingStatus === "comped") return "Comped";
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

  if (billing.billingPolicy === "comped" || billing.billingStatus === "comped") return "Free account";
  if (billing.billingStatus === "past_due" && !billing.stripeSubscriptionId && billing.trialEndsAt) return "Trial ended";
  if (billing.billingStatus === "past_due") return "Payment needs attention";
  if (billing.billingStatus === "canceled") return "Subscription canceled";
  if (billing.billingStatus === "active") return "Subscription active";
  if (lifecycle.activationReady) return "Trial activation in progress";
  return "Monthly trial waits for text-back";
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
      return `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left in your trial. Stripe begins $99/month afterward unless you cancel.`;
    }

    if (trialDate) {
      return `Your trial ended ${trialDate}. Check Stripe for the current invoice and subscription status.`;
    }

    return "Your Stripe-owned trial is active.";
  }

  if (billing.billingPolicy === "comped" || billing.billingStatus === "comped") {
    return "Relay isn't charging this account.";
  }

  if (billing.billingStatus === "past_due") {
    if (!billing.stripeSubscriptionId && billing.trialEndsAt) {
      return trialDate
        ? `Your trial ended ${trialDate}. Update payment securely in Stripe.`
        : "Your trial ended. Update payment securely in Stripe.";
    }

    return "Update payment so the subscription stays in good standing.";
  }

  if (billing.billingStatus === "canceled") {
    return lifecycle.activationReady
      ? "Restart the subscription when you're ready to treat this account as paid."
      : "Finish setup before restarting billing.";
  }

  if (
    billing.setupFeeStatus === "due" ||
    billing.setupFeeStatus === "refunded" ||
    billing.setupFeeStatus === "charged_back"
  ) {
    return "The one-time $150 setup fee is due. It saves your card in Stripe, but the monthly trial waits for automatic text-back activation.";
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

  if (lifecycle.ownerAction === "add_payment_method") {
    return (
      <form action="/api/billing/payment-method" method="post">
        <button className="btn btn-primary settings-billing__action" type="submit">
          Add payment method
        </button>
      </form>
    );
  }

  if (billing.billingPolicy === "comped" || billing.billingStatus === "comped") {
    return null;
  }

  if (lifecycle.ownerAction === "wait_for_activation") {
    return <p className="settings-section__meta">Relay is starting your trial automatically.</p>;
  }

  if (lifecycle.ownerAction === "restart_subscription") {
    return (
      <form action="/api/billing/checkout" method="post">
        <button className="btn btn-primary settings-billing__action" type="submit">
          Restart subscription
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
          Manage billing
        </button>
      </form>
    );
  }

  return <p className="settings-section__meta">Contact Relay support to resolve billing.</p>;
}

function BillingActions({
  billing,
  lifecycle,
  role,
}: {
  billing: AccountBillingRecord;
  lifecycle: BillingLifecycleState;
  role: string;
}) {
  const primaryUsesPortal =
    lifecycle.ownerAction === "manage_billing" ||
    lifecycle.ownerAction === "update_payment";
  const canOpenPortal =
    role === "owner" &&
    Boolean(billing.stripeCustomerId) &&
    !primaryUsesPortal;

  return (
    <div className="settings-billing__actions">
      <BillingPrimaryAction billing={billing} lifecycle={lifecycle} role={role} />
      {canOpenPortal ? (
        <form action="/api/billing/portal" method="post">
          <button className="btn btn-ghost" type="submit">
            Manage billing
          </button>
        </form>
      ) : null}
    </div>
  );
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
  const trialDays = billing.commercialOffer === "founding_pilot" ? 30 : 14;
  const setupFeeLabel = billing.setupFeeStatus === "paid"
    ? `Paid${setupFeeDate ? ` ${setupFeeDate}` : ""}`
    : billing.setupFeeStatus === "waived"
      ? "Waived"
      : billing.setupFeeStatus === "partially_refunded"
        ? `Partially refunded ($${(billing.setupFeeRefundedCents / 100).toFixed(2)})`
      : billing.setupFeeStatus === "refunded"
        ? "Refunded"
        : billing.setupFeeStatus === "disputed"
          ? "Payment disputed"
          : billing.setupFeeStatus === "charged_back"
            ? "Charged back"
            : billing.firstPaidAt
              ? "Settled through prior activation"
              : "$150 due";
  const setupFeeDetail = billing.setupFeeStatus === "due"
    ? "One time. Securely paid through Stripe."
    : billing.setupFeeStatus === "waived"
      ? "Your founding-pilot setup fee is waived."
      : billing.billingPolicy === "comped"
        ? "Relay is not charging this account."
        : "This is separate from your monthly service.";
  const canRequestRefund =
    role === "owner" &&
    (billing.setupFeeStatus === "paid" || billing.setupFeeStatus === "partially_refunded");

  return (
    <section id="billing" className="panel settings-section settings-billing customer-billing">
      <div className="settings-billing__main">
        <div>
          <p className="t-eyebrow settings-section__title">Billing</p>
          <h2 className="settings-billing__plan">Current plan: $99/month</h2>
          <p className="settings-section__lead">{billingHeadline(billing, lifecycle)}</p>
          <p className="settings-section__meta">{billingSummary(billing, lifecycle)}</p>
          {lifecycle.ownerAction === "restart_subscription" ? (
            <p className="settings-section__meta settings-billing__charge-copy">
              Stripe Checkout will charge $99 now, then $99 monthly until canceled.
            </p>
          ) : null}
          {billing.stripeCustomerId ? (
            <p className="settings-section__meta customer-billing__stripe-note">
              Stripe securely handles payment methods, invoices, billing details, and cancellation.
            </p>
          ) : null}
          {billing.billingStatus !== "active" || billing.cancelAtPeriodEnd ? (
            <p className="settings-section__meta settings-billing__reassurance">
              A failed payment does not immediately interrupt missed-call capture.
            </p>
          ) : null}
        </div>
        <BillingActions billing={billing} lifecycle={lifecycle} role={role} />
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
        <div>
          <dt>Monthly service</dt>
          <dd>$99/month</dd>
          <small>{billing.billingStatus === "trialing" ? "Your Stripe trial is active." : `${trialDays}-day trial starts after automatic text-back is on.`}</small>
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
          <dd>{setupFeeLabel}</dd>
          <small>{setupFeeDetail}</small>
        </div>
      </dl>

      {canRequestRefund ? (
        <p className="settings-section__meta settings-billing__support">
          Need help with a charge or refund?{" "}
          <a href="mailto:relaynw@gmail.com?subject=Relay%20billing%20or%20refund%20request">
            Contact Relay about billing or a refund
          </a>
          . Refund status updates here only after Stripe confirms it.
        </p>
      ) : null}
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
  const [a2pStatus, billing, technicalStatus] = await Promise.all([
    getA2pRegistrationStatus(session.accountId),
    getAccountBillingRecord(session.accountId),
    getAccountTechnicalSetupStatus(session.accountId),
  ]);
  const billingLifecycle = computeBillingLifecycle({
    billing,
    technicalStatus,
    a2pStatus: (a2pStatus ?? "not_started") as A2pRegistrationStatus,
    smsEnabled: account.smsEnabled,
  });
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
          eyebrow="Account settings"
          title={account.businessName}
          subtitle={readOnly ? "View-only access" : "Manage your business details, automatic text-back, and voicemail."}
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
                  ? "Relay is still enabling automatic texting. Missed-call capture continues normally."
                  : "Please check the highlighted values and try again."}
          </div>
        ) : null}
        {params.billing ? (
          <div className="intake-error settings-notice" role="alert">
            <Icon name="info" size={14} />
            {params.billing === "setup_incomplete"
              ? "Confirm that a real missed call reaches Relay before starting billing."
              : params.billing === "initial_trial_managed_automatically"
                ? "Your initial trial starts automatically only when automatic text-back is fully active."
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
                      : params.billing === "payment_method_required"
                        ? "Add a payment method securely in Stripe before automatic text-back is activated."
                      : params.billing === "payment_method_checkout_failed"
                        ? "Stripe could not open the secure card form. Try again."
                      : params.billing === "payment_method_ready"
                        ? "Stripe already has a payment method ready for this account."
                      : params.billing === "payment_method_success"
                        ? "Payment method saved. Nothing was charged; your trial still waits for automatic text-back activation."
                      : params.billing === "restart_required"
                        ? "This account already used its free trial. Restart the subscription securely in Stripe."
                      : params.billing === "conflicting_subscription"
                        ? "Stripe has another subscription that must be resolved before activation."
                      : params.billing === "activation_sync_pending"
                        ? "Automatic text-back is on. Stripe activation is being synchronized; Relay will retry safely."
                      : params.billing === "portal_failed"
                          ? "Stripe Billing Portal could not be opened. Try again."
                          : params.billing === "relink_required"
                            ? "Your billing link was stale and has been cleared. Reconnect securely through Stripe."
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
            {A2P_LABELS[a2pStatus ?? ""] ?? "Relay is checking texting availability"}
          </p>
        </section>

        <BillingSection billing={billing} lifecycle={billingLifecycle} role={role} />

        <form className="panel settings-form" action="/api/settings" method="POST">
          <fieldset disabled={readOnly} className="settings-fieldset">
            <p className="t-eyebrow settings-group-title settings-group-title--first">Business</p>
            <Field label="Business name" hint="Used in texts and voicemail greetings.">
              <input className="field" name="business_name" required maxLength={120} defaultValue={account.businessName} />
            </Field>
            <Field label="Owner or admin name" hint="Optional contact name.">
              <input className="field" name="owner_name" maxLength={120} defaultValue={account.ownerName ?? ""} />
            </Field>
            <Field label="Owner phone" hint="Where calls forward and Relay alerts are texted.">
              <input className="field" name="owner_phone_number" required defaultValue={account.ownerPhoneNumber} />
            </Field>
            <Field label="Notification email" hint="Lead notifications and reports. This does not change the sign-in email.">
              <input className="field" type="email" name="owner_email" required defaultValue={account.ownerEmail ?? ""} />
            </Field>
            <p className="form-field__hint">Sign-in email: <strong>{session.email}</strong>. Login access is managed separately so a contact edit cannot lock anyone out.</p>
            <Field
              label="Existing public business number"
              hint={account.callMode === "forwarding"
                ? "Required for forwarding instructions. This is the number customers call today."
                : "Optional in direct mode because customers call the Relay number."}
            >
              <input
                className="field"
                name="public_business_number"
                required={account.callMode === "forwarding"}
                defaultValue={account.publicBusinessNumber ?? ""}
              />
            </Field>
            <Field label="Business hours" hint="Plain language is fine, for example Mon-Fri 7am-5pm.">
              <textarea className="field" name="business_hours" rows={3} maxLength={1000} defaultValue={typeof account.businessHours?.summary === "string" ? account.businessHours.summary : ""} />
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

            <p id="texting" className="t-eyebrow settings-group-title">Automatic text-back</p>
            {role === "owner" ? (
              <SmsToggle
                defaultEnabled={account.smsEnabled}
                available={a2pStatus === "approved"}
              />
            ) : null}
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
            <Field label="Greeting preference">
              <select className="field" name="greeting_preference" defaultValue={account.greetingPreference}>
                <option value="generated">Use a generated voice greeting</option>
                <option value="recorded">Record my own greeting</option>
              </select>
            </Field>
            <Field label="Recorded greeting" hint="Record, stop, then play it back. Relay converts it to a phone-ready WAV file.">
              <GreetingRecorder initialUrl={account.missedCallGreetingAudioUrl} />
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

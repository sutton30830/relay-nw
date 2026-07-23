import { AppHeader } from "@/app/leads/_components/app-header";
import { PageHead } from "@/app/leads/_components/page-head";
import { CarrierForwarding } from "./carrier-forwarding";
import { FullTestPanel } from "@/app/leads/_components/full-test-panel";
import { Icon } from "@/components/icon";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { computeBillingReadiness } from "@/lib/billing";
import type { BillingReadiness } from "@/lib/billing";
import { ownerOnboardingDelayMessage } from "@/lib/onboarding-deadlines";
import {
  getA2pRegistrationStatus,
  getCarrierProfile,
  getAccountBillingRecord,
  getAccountRecoveryStats,
  getForwardingHealthSummary,
  getLastRecoveredCallAt,
} from "@/lib/supabase";
import { computeSetupReadiness, type A2pStatus } from "@/lib/readiness";
import { formatRelativeAge } from "@/lib/report-metrics";
import { isCustomerProfileComplete, missingCustomerProfileFields } from "@/lib/onboarding-profile";
import { computeOwnerJourney } from "@/lib/owner-journey";

export const dynamic = "force-dynamic";

const A2P_LABELS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In carrier review",
  approved: "Approved",
  rejected: "Rejected",
  paused: "Paused",
};

const A2P_DETAILS: Record<string, string> = {
  not_started: "Texting stays off until your carrier registration is approved.",
  in_progress: "Your carrier review is in progress. You can still test calls and voicemail now.",
  approved: "Your carrier registration is approved, so automatic texting can be enabled safely.",
  rejected: "Your carrier registration needs attention before Relay texts callers.",
  paused: "Texting is paused until registration is active again.",
};

function statusTone(status: "complete" | "pending" | "blocked") {
  if (status === "complete") return "setup-status__step--complete";
  if (status === "blocked") return "setup-status__step--blocked";
  return "setup-status__step--pending";
}

function Step({
  title,
  detail,
  status,
}: {
  title: string;
  detail: string;
  status: "complete" | "pending" | "blocked";
}) {
  return (
    <li className={`setup-status__step ${statusTone(status)}`}>
      <span className="setup-status__dot">
        <Icon name={status === "complete" ? "check" : status === "blocked" ? "alertTriangle" : "clock"} size={13} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </li>
  );
}

function ReadinessFact({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "warn" | "neutral";
}) {
  return (
    <div className={`readiness__fact readiness__fact--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function BillingAction({ billingReadiness, role }: { billingReadiness: BillingReadiness; role: string }) {
  if (
    billingReadiness.state === "active" ||
    billingReadiness.state === "trialing" ||
    billingReadiness.state === "comped"
  ) {
    return null;
  }

  if (billingReadiness.ownerAction === "pay_setup_fee") {
    if (role !== "owner") {
      return <p className="setup-panel__note">Relay will collect the one-time setup fee before hands-on setup begins.</p>;
    }

    return (
      <form action="/api/billing/setup-fee" method="post" className="setup-panel__action">
        <button className="btn btn-primary" type="submit">
          Pay $150 setup fee
        </button>
        <p>The setup fee is separate from monthly billing. Texting approval does not delay call capture or monthly billing.</p>
      </form>
    );
  }

  if (billingReadiness.state === "billing_attention") {
    return (
      <p className="setup-panel__note">
        Billing needs attention. Relay keeps capturing missed calls while billing is resolved.
      </p>
    );
  }

  if (!billingReadiness.activationReady) {
    return (
      <p className="setup-panel__note">
        Confirm that a real missed call reaches Relay before starting billing.
      </p>
    );
  }

  if (role !== "owner") {
    return <p className="setup-panel__note">Ask the owner to start billing when setup is complete.</p>;
  }

  return (
    <form action="/api/billing/checkout" method="post" className="setup-panel__action">
      <button className="btn btn-primary" type="submit">
        Start billing
      </button>
      <p>Opens secure Stripe Checkout. Relay does not turn off missed-call capture in this phase.</p>
    </form>
  );
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ carrier?: string }>;
}) {
  const session = await requireAccountUser();
  const { account, accountId, role, membershipCount } = session;
  const notices = await searchParams;
  const [forwardingHealth, a2pStatus, recovery, lastRecoveredCallAt, billing, carrierProfile] = await Promise.all([
    getForwardingHealthSummary(accountId),
    getA2pRegistrationStatus(accountId),
    getAccountRecoveryStats(accountId, { since: null }),
    getLastRecoveredCallAt(accountId),
    getAccountBillingRecord(accountId),
    getCarrierProfile(accountId),
  ]);

  const carrierStatus = a2pStatus ?? "unknown";
  const isA2pApproved = carrierStatus === "approved";
  const profileFacts = {
    businessName: account.businessName,
    ownerName: account.ownerName,
    ownerEmail: account.ownerEmail,
    ownerPhoneNumber: account.ownerPhoneNumber,
    publicBusinessNumber: account.publicBusinessNumber,
    businessType: account.businessType,
    callMode: account.callMode,
  };
  const isProfileReady = isCustomerProfileComplete(profileFacts);
  const missingProfile = missingCustomerProfileFields(profileFacts);
  const smsMetric = isA2pApproved
    ? account.smsEnabled
      ? { value: "Auto-text on", detail: "Carrier approved. Callers get an immediate reply.", tone: "good" as const }
      : { value: "Paused", detail: "Carrier approved. Missed calls still reach your inbox.", tone: "neutral" as const }
    : {
        value: "Not ready",
        detail: carrierStatus === "rejected" ? "Carrier registration needs attention" : "Waiting on carrier registration",
        tone: "warn" as const,
      };

  // One decisive operating state with a single next action, so Setup leads
  // instead of listing four half-answers.
  const readiness = computeSetupReadiness({
    role,
    hasProfile: isProfileReady,
    callMode: account.callMode,
    smsEnabled: account.smsEnabled,
    a2pStatus: (["not_started", "in_progress", "approved", "rejected", "paused"].includes(carrierStatus)
      ? carrierStatus
      : "unknown") as A2pStatus,
    forwardingStatus: forwardingHealth.displayStatus,
    hasRecoveredCall: recovery.missedCalls > 0,
    lastRecoveredCallAt,
    forwardingLastPassedAt: forwardingHealth.lastPassedAt,
  });
  const journey = computeOwnerJourney({
    setupFeeStatus: billing.setupFeeStatus,
    firstPaidAt: billing.firstPaidAt,
    profileComplete: isProfileReady,
    twilioNumberAssigned: Boolean(account.twilioPhoneNumber),
    a2pStatus: carrierStatus,
    billingStatus: billing.billingStatus,
    activatedAt: billing.activatedAt,
    callCaptureVerified: readiness.callCaptureReady,
  });
  const billingReadiness = computeBillingReadiness({
    billing,
    setupReadiness: readiness,
  });
  const onboardingDelayMessage = ownerOnboardingDelayMessage({
    hasBusinessProfile: isProfileReady,
    onboardingStatus: billingReadiness.onboardingStatus,
    requirementsDueAt: billingReadiness.onboardingStatus === "waiting_on_customer" ? billing.requirementsDueAt : null,
  });


  return (
    <main className="leads-view">
      <section className="leads-shell setup-status">
        <AppHeader
          businessName={account.businessName}
          currentPage="setup"
          showOperations={isRelayOperator(session)}
          switchAccountHref={membershipCount > 1 ? "/account/select?next=/setup" : undefined}
        />

        <PageHead
          eyebrow="Setup"
          title={account.businessName}
          subtitle="Connect your phone line, test missed-call forwarding, and make sure Relay can text from your number."
        />

        {/* The journey: where you are, whose turn it is, in five phases. */}
        <section className="journey" aria-label="Setup journey">
          <ol className="journey__rail">
            {journey.phases.map((phase, index) => (
              <li key={phase.key} className={`journey__phase journey__phase--${phase.state}`} aria-current={phase.state === "current" ? "step" : undefined}>
                <span className="journey__marker">{phase.state === "done" ? <Icon name="check" size={12} /> : index + 1}</span>
                <span className="journey__label">{phase.label}</span>
                <span className="journey__detail">{phase.detail}</span>
                {phase.state === "current" && phase.turn !== "you" ? (
                  <span className="journey__turn">Nothing needed from you</span>
                ) : phase.state === "current" ? (
                  <span className="journey__turn journey__turn--you">Your turn</span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>

        <section className={`readiness readiness--${readiness.state}`} aria-label="Relay status">
          <div className="readiness__main">
            <span className="readiness__badge">
              <span className="readiness__dot" aria-hidden="true" />
              {readiness.stateLabel}
            </span>
            <h2 className="readiness__headline">{readiness.headline}</h2>
            <p className="readiness__summary">{readiness.summary}</p>
            {readiness.callCaptureReady && readiness.evidence ? (
              <p className="readiness__evidence" suppressHydrationWarning>
                <Icon name="check" size={13} />
                Confirmed {formatRelativeAge(readiness.evidence.at, Date.now())} — {readiness.evidence.label.toLowerCase()}
              </p>
            ) : null}
            <div className="readiness__facts" aria-label="Setup details">
              <ReadinessFact
                label="Call mode"
                value={account.callMode === "forwarding" ? "Forwarding" : "Direct"}
                detail={account.callMode === "forwarding" ? "Keep your public business number" : "Use the Relay number directly"}
              />
              <ReadinessFact
                label="Texting"
                value={smsMetric.value}
                detail={smsMetric.detail}
                tone={smsMetric.tone}
              />
              <ReadinessFact
                label="Billing"
                value={billingReadiness.label}
                detail={billingReadiness.summary}
                tone={billingReadiness.tone}
              />
            </div>
          </div>
          {/* Plain anchor (not next/link): the test actions point to
              /setup#live-tests, and a same-page hash must scroll to the tool
              natively rather than soft-navigating the page it's already on. */}
          {readiness.nextAction ? (
            <a className="btn btn-primary readiness__action" href={readiness.nextAction.href}>
              {readiness.nextAction.label}
            </a>
          ) : null}
        </section>

        {onboardingDelayMessage ? (
          <div className="intake-error settings-notice" role="status">
            <Icon name="info" size={14} />
            {onboardingDelayMessage}
          </div>
        ) : null}

        <section className="panel setup-panel" id="carrier-registration" aria-label="Carrier registration information">
          <div className="setup-panel__head">
            <div>
              <p className="t-eyebrow">Carrier registration</p>
              <h2 className="t-display">Tell carriers who is sending messages.</h2>
              <p className="setup-copy">Relay submits this after you finish it. Your registration number is encrypted; only the last four digits remain visible here.</p>
            </div>
          </div>
          {notices.carrier ? (
            <div className={notices.carrier === "saved" ? "settings-notice settings-notice--ok" : "intake-error settings-notice"} role="status">
              {notices.carrier === "saved" ? "Carrier information saved. Relay will review it before submission."
                : notices.carrier === "registration_id_required" ? "Enter the EIN or registration number for this business."
                  : notices.carrier === "invalid_url" ? "Privacy and terms links must begin with https://."
                    : "Complete the required carrier fields and include at least two sample messages."}
            </div>
          ) : null}
          <form action="/api/setup/carrier-profile" method="post" className="settings-form">
            <fieldset disabled={role === "viewer"} className="settings-fieldset">
              <div className="form-field">
                <span className="t-eyebrow form-field__label">Does this business have an EIN?</span>
                <select className="field" name="has_ein" defaultValue={carrierProfile?.hasEin === false ? "no" : "yes"}>
                  <option value="yes">Yes — register as a business</option>
                  <option value="no">No — register as a sole proprietor</option>
                </select>
              </div>
              <label className="form-field">
                <span className="t-eyebrow form-field__label">EIN or registration number</span>
                <input className="field" name="registration_id" autoComplete="off" placeholder={carrierProfile?.registrationIdLast4 ? `Saved ending in ${carrierProfile.registrationIdLast4} — leave blank to keep it` : "Required when the business has an EIN"} />
              </label>
              <div className="lead-controls">
                <input className="field" name="representative_first_name" required defaultValue={carrierProfile?.representativeFirstName ?? ""} placeholder="Authorized representative first name" aria-label="Authorized representative first name" />
                <input className="field" name="representative_last_name" required defaultValue={carrierProfile?.representativeLastName ?? ""} placeholder="Last name" aria-label="Authorized representative last name" />
              </div>
              <div className="lead-controls">
                <input className="field" name="representative_title" defaultValue={carrierProfile?.representativeTitle ?? ""} placeholder="Job title" aria-label="Authorized representative title" />
                <input className="field" name="representative_mobile" required defaultValue={carrierProfile?.representativeMobile ?? account.ownerPhoneNumber} placeholder="Mobile for verification" aria-label="Authorized representative mobile" />
                <input className="field" type="email" name="representative_email" required defaultValue={carrierProfile?.representativeEmail ?? account.ownerEmail ?? ""} placeholder="Representative email" aria-label="Authorized representative email" />
              </div>
              <label className="form-field">
                <span className="t-eyebrow form-field__label">How Relay messages customers</span>
                <textarea className="field" name="messaging_use_case" rows={3} required defaultValue={carrierProfile?.messagingUseCase ?? "Relay sends one customer-care text after a caller phones the business and the call is missed, then supports replies about that service request."} />
              </label>
              <label className="form-field">
                <span className="t-eyebrow form-field__label">How callers consent</span>
                <textarea className="field" name="opt_in_flow" rows={3} required defaultValue={carrierProfile?.optInFlow ?? "The customer initiates contact by calling the business. If the call is unanswered, the voicemail greeting discloses that Relay may send a follow-up text. The first text identifies the business and includes STOP instructions."} />
              </label>
              <label className="form-field">
                <span className="t-eyebrow form-field__label">Sample messages</span>
                <textarea className="field" name="sample_messages" rows={4} required defaultValue={(carrierProfile?.sampleMessages.length ? carrierProfile.sampleMessages : [
                  `Hi, this is ${account.businessName}. Sorry we missed your call. How can we help? Reply STOP to opt out.`,
                  `Thanks for calling ${account.businessName}. We received your message and will follow up shortly. Reply STOP to opt out.`,
                ]).join("\n")} />
                <span className="form-field__hint">One message per line; include the business name and STOP language.</span>
              </label>
              <div className="lead-controls">
                <input className="field" type="url" name="privacy_policy_url" defaultValue={carrierProfile?.privacyPolicyUrl ?? ""} placeholder="https://…/privacy" aria-label="Privacy policy URL" />
                <input className="field" type="url" name="terms_url" defaultValue={carrierProfile?.termsUrl ?? ""} placeholder="https://…/terms" aria-label="Terms URL" />
              </div>
              {role !== "viewer" ? <button className="btn btn-primary" type="submit">Save carrier information</button> : null}
            </fieldset>
          </form>
        </section>

        <section className="setup-grid">
          <article className="panel setup-panel">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Checklist</p>
                <h2 className="t-display">Get Relay ready for your next missed call.</h2>
              </div>
            </div>
            <ol className="setup-status__steps">
              <Step
                title="Business profile"
                detail={isProfileReady
                  ? `${account.ownerPhoneNumber} is where Relay sends alerts. ${role === "viewer" ? "Ask an owner or admin to edit settings." : "Edit settings if this is wrong."}`
                  : `Still needed: ${missingProfile.join(", ")}.`}
                status={isProfileReady ? "complete" : "blocked"}
              />
              <Step
                title="Carrier registration"
                detail={A2P_DETAILS[carrierStatus] ?? "Carrier status is unknown. Check with Relay support before texting callers."}
                status={isA2pApproved ? "complete" : carrierStatus === "rejected" || carrierStatus === "paused" ? "blocked" : "pending"}
              />
              <Step
                title="Call routing test"
                detail={account.callMode === "forwarding"
                  ? "Use Start listening, then call your business number and let it go unanswered."
                  : "Direct mode routes calls through the Relay number without carrier forwarding."}
                status={readiness.callCaptureReady ? "complete" : "pending"}
              />
              <Step
                title="Automatic SMS readiness"
                detail={readiness.checks.find((check) => check.key === "texting")?.detail ?? "Check automatic texting status."}
                status={
                  readiness.operatingState === "live_sms_on"
                    ? "complete"
                    : readiness.operatingState === "live_sms_paused"
                      ? "pending"
                      : carrierStatus === "rejected" || carrierStatus === "paused"
                        ? "blocked"
                        : "pending"
                }
              />
              <Step
                title="Billing activation"
                detail={billingReadiness.summary}
                status={
                  billingReadiness.state === "active" ||
                  billingReadiness.state === "trialing" ||
                  billingReadiness.state === "comped"
                    ? "complete"
                    : billingReadiness.state === "billing_attention"
                      ? "blocked"
                      : "pending"
                }
              />
            </ol>
            <BillingAction billingReadiness={billingReadiness} role={role} />
          </article>

          <article className="panel setup-panel">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Relay line</p>
                <h2 className="t-display">Your numbers and texting status.</h2>
              </div>
            </div>
            <dl className="setup-details">
              <div>
                <dt>Relay number</dt>
                <dd>{account.twilioPhoneNumber}</dd>
              </div>
              <div>
                <dt>Your phone</dt>
                <dd>{account.ownerPhoneNumber}</dd>
              </div>
              <div>
                <dt>Texting registration</dt>
                <dd>{A2P_LABELS[carrierStatus] ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{account.ownerEmail ?? "Not set"}</dd>
              </div>
            </dl>
          </article>
        </section>

        <section className="setup-grid">
          <article className="panel setup-panel">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Call forwarding</p>
                <h2 className="t-display">Set up forwarding from your business number.</h2>
              </div>
            </div>
            {account.callMode === "forwarding" ? (
              <CarrierForwarding relayNumber={account.twilioPhoneNumber} />
            ) : (
              <p className="setup-copy">
                Direct mode is active. Use the Relay number as your public call number, then make a real missed-call test before relying on it.
              </p>
            )}
          </article>

          <article id="live-tests" className="panel setup-panel setup-panel--tests">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Full test</p>
                <h2 className="t-display">Confirm Relay works end to end.</h2>
              </div>
            </div>
            <FullTestPanel
              initialForwardingSummary={forwardingHealth}
              showForwarding={account.callMode === "forwarding"}
            />
          </article>
        </section>
      </section>
    </main>
  );
}

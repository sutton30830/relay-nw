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
  getAccountBillingRecord,
  getAccountRecoveryStats,
  getForwardingHealthSummary,
  getLastRecoveredCallAt,
} from "@/lib/supabase";
import { computeSetupReadiness, type A2pStatus } from "@/lib/readiness";
import { formatRelativeAge } from "@/lib/report-metrics";

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

function MetricCard({
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
    <article className={`setup-metric setup-metric--${tone}`}>
      <p className="t-eyebrow">{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
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
        Finish call capture and carrier texting setup before starting billing.
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

export default async function SetupPage() {
  const session = await requireAccountUser();
  const { account, accountId, role, membershipCount } = session;
  const [forwardingHealth, a2pStatus, recovery, lastRecoveredCallAt, billing] = await Promise.all([
    getForwardingHealthSummary(accountId),
    getA2pRegistrationStatus(accountId),
    getAccountRecoveryStats(accountId, { since: null }),
    getLastRecoveredCallAt(accountId),
    getAccountBillingRecord(accountId),
  ]);

  const carrierStatus = a2pStatus ?? "unknown";
  const isA2pApproved = carrierStatus === "approved";
  const isProfileReady = Boolean(account.businessName && account.ownerPhoneNumber && account.twilioPhoneNumber);
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
  const billingReadiness = computeBillingReadiness({
    billing,
    setupReadiness: readiness,
  });
  const onboardingDelayMessage = ownerOnboardingDelayMessage({
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

        <section className="setup-metrics" aria-label="Setup details">
          <MetricCard
            label="Call mode"
            value={account.callMode === "forwarding" ? "Forwarding" : "Direct"}
            detail={account.callMode === "forwarding" ? "Keep your public business number" : "Use the Relay number directly"}
          />
          <MetricCard
            label="Texting"
            value={smsMetric.value}
            detail={smsMetric.detail}
            tone={smsMetric.tone}
          />
          <MetricCard
            label="Billing"
            value={billingReadiness.label}
            detail={billingReadiness.summary}
            tone={billingReadiness.tone}
          />
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
                detail={`${account.ownerPhoneNumber} is where Relay sends alerts. ${role === "viewer" ? "Ask an owner or admin to edit settings." : "Edit settings if this is wrong."}`}
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

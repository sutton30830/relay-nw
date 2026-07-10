import Link from "next/link";
import { CopyButton } from "@/app/copy-button";
import { ForwardingHealthCard } from "@/app/leads/_components/forwarding-health-card";
import { SmsHealthCard } from "@/app/leads/_components/sms-health-card";
import { Icon } from "@/components/icon";
import { requireAccountUser } from "@/lib/auth";
import { getA2pRegistrationStatus, getForwardingHealthSummary } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const A2P_LABELS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In carrier review",
  approved: "Approved",
  rejected: "Rejected",
  paused: "Paused",
};

const A2P_DETAILS: Record<string, string> = {
  not_started: "Texting stays off until carrier registration is underway and approved.",
  in_progress: "Carrier review is in progress. Calls and voicemail can be tested now.",
  approved: "Carrier registration is approved, so automatic texting can be enabled safely.",
  rejected: "Carrier registration needs attention before customer texts should go live.",
  paused: "Texting is paused until registration is active again.",
};

function statusTone(status: "complete" | "pending" | "blocked") {
  if (status === "complete") return "setup-status__step--complete";
  if (status === "blocked") return "setup-status__step--blocked";
  return "setup-status__step--pending";
}

function carrierCodeExample(prefix: string, relayNumber: string) {
  const digits = relayNumber.replace(/\D/g, "");
  return digits ? `${prefix}${digits}#` : "";
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

export default async function SetupPage() {
  const { account, accountId, role } = await requireAccountUser();
  const [forwardingHealth, a2pStatus] = await Promise.all([
    getForwardingHealthSummary(accountId),
    getA2pRegistrationStatus(accountId),
  ]);

  const carrierStatus = a2pStatus ?? "unknown";
  const isA2pApproved = carrierStatus === "approved";
  const isProfileReady = Boolean(account.businessName && account.ownerPhoneNumber && account.twilioPhoneNumber);
  const isForwardingReady = account.callMode === "direct" || forwardingHealth.displayStatus === "passed";
  const isSmsReady = account.smsEnabled && isA2pApproved;
  const completedSteps = [isProfileReady, isA2pApproved, isForwardingReady, isSmsReady].filter(Boolean).length;
  const noAnswerCode = carrierCodeExample("*61*", account.twilioPhoneNumber);
  const busyCode = carrierCodeExample("*67*", account.twilioPhoneNumber);
  const unreachableCode = carrierCodeExample("*62*", account.twilioPhoneNumber);

  return (
    <main className="leads-view">
      <section className="leads-shell setup-status">
        <header className="leads-header">
          <div>
            <p className="t-eyebrow">Setup</p>
            <h1 className="t-display">{account.businessName}</h1>
            <p className="leads-subtitle">
              Confirm the Relay line, carrier registration, forwarding test, and owner SMS before go-live.
            </p>
          </div>
          <div className="lead-actions">
            <Link className="btn btn-secondary" href="/leads">Inbox</Link>
            <Link className="btn btn-secondary" href="/settings">Settings</Link>
          </div>
        </header>

        <section className="setup-metrics" aria-label="Setup readiness">
          <MetricCard
            label="Setup progress"
            value={`${completedSteps}/4`}
            detail={completedSteps === 4 ? "Ready for a supervised launch" : "Finish the remaining checks before launch"}
            tone={completedSteps === 4 ? "good" : "warn"}
          />
          <MetricCard
            label="Call mode"
            value={account.callMode === "forwarding" ? "Forwarding" : "Direct"}
            detail={account.callMode === "forwarding" ? "Customer keeps their public number" : "Customer calls the Relay number directly"}
          />
          <MetricCard
            label="Texting"
            value={account.smsEnabled ? "Enabled" : "Off"}
            detail={isA2pApproved ? "Carrier registration approved" : "Waiting on A2P approval"}
            tone={isSmsReady ? "good" : "warn"}
          />
        </section>

        <section className="setup-grid">
          <article className="panel setup-panel">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Go-live checklist</p>
                <h2 className="t-display">The shortest path to a working account.</h2>
              </div>
            </div>
            <ol className="setup-status__steps">
              <Step
                title="Business profile"
                detail={`${account.ownerPhoneNumber} is the owner phone. ${role === "viewer" ? "Ask an owner/admin to edit settings." : "Edit settings if this is wrong."}`}
                status={isProfileReady ? "complete" : "blocked"}
              />
              <Step
                title="Carrier registration"
                detail={A2P_DETAILS[carrierStatus] ?? "Carrier status is unknown. Verify provisioning before texting customers."}
                status={isA2pApproved ? "complete" : carrierStatus === "rejected" || carrierStatus === "paused" ? "blocked" : "pending"}
              />
              <Step
                title="Call routing test"
                detail={account.callMode === "forwarding"
                  ? "Use Start listening, then call the business number and let it go unanswered."
                  : "Direct mode routes calls through the Relay number without carrier forwarding."}
                status={isForwardingReady ? "complete" : "pending"}
              />
              <Step
                title="Automatic SMS readiness"
                detail={account.smsEnabled
                  ? "Automatic texting is enabled. Send an owner-only SMS test below before relying on it."
                  : "Automatic SMS is off. Enable it from Settings after A2P is approved."}
                status={isSmsReady ? "complete" : "blocked"}
              />
            </ol>
          </article>

          <article className="panel setup-panel">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Relay line</p>
                <h2 className="t-display">Numbers and registration.</h2>
              </div>
            </div>
            <dl className="setup-details">
              <div>
                <dt>Relay number</dt>
                <dd>{account.twilioPhoneNumber}</dd>
              </div>
              <div>
                <dt>Owner phone</dt>
                <dd>{account.ownerPhoneNumber}</dd>
              </div>
              <div>
                <dt>A2P status</dt>
                <dd>{A2P_LABELS[carrierStatus] ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Owner email</dt>
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
                <h2 className="t-display">Guide the owner through their carrier setup.</h2>
              </div>
            </div>
            {account.callMode === "forwarding" ? (
              <>
                <p className="setup-copy">
                  The owner should configure their existing business number to forward unanswered, busy, and unreachable calls to the Relay number. The examples below work for many US mobile carriers, but carrier apps, landlines, VoIP providers, and some regional carriers use different steps.
                </p>
                <p className="setup-copy setup-copy--tight">
                  Treat these as starting points, then confirm against the customer&apos;s carrier instructions before launch.
                </p>
                <div className="setup-codes">
                  {[
                    ["No answer", noAnswerCode],
                    ["Busy", busyCode],
                    ["Unreachable", unreachableCode],
                  ].map(([label, code]) => (
                    <div className="setup-code" key={label}>
                      <div>
                        <span>{label}</span>
                        <strong>{code || "Add Relay number first"}</strong>
                      </div>
                      {code ? <CopyButton value={code} label="Copy" /> : null}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="setup-copy">
                Direct mode is active. Use the Relay number as the public call number, then make a real missed-call test before launch.
              </p>
            )}
          </article>

          <article className="panel setup-panel setup-panel--tests">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Live tests</p>
                <h2 className="t-display">Prove the loop before launch.</h2>
              </div>
            </div>
            {account.callMode === "forwarding" ? (
              <ForwardingHealthCard initialSummary={forwardingHealth} />
            ) : null}
            <SmsHealthCard />
          </article>
        </section>
      </section>
    </main>
  );
}

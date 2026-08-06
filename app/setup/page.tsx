import { AppHeader } from "@/app/leads/_components/app-header";
import { PageHead } from "@/app/leads/_components/page-head";
import { Icon } from "@/components/icon";
import Link from "next/link";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { loadAccountOnboardingReadiness } from "@/lib/onboarding-readiness";
import { CarrierForwarding } from "./carrier-forwarding";

export const dynamic = "force-dynamic";

function RelayHelpLink({ businessName }: { businessName: string }) {
  const subject = encodeURIComponent(`Relay setup help for ${businessName}`);

  return (
    <a className="btn btn-secondary" href={`mailto:relaynw@gmail.com?subject=${subject}`}>
      Get help from Relay
    </a>
  );
}

function onboardingNotice(status: string | undefined) {
  if (status === "notification_confirmed") return "Thanks — your notification receipt is now part of the launch evidence.";
  if (status === "approved") return "Go-live approved. Relay recorded your authenticated approval.";
  if (status === "owner_required") return "Only the account owner can confirm tests or approve go-live.";
  if (status === "confirmation_required") return "Check the confirmation box before continuing.";
  if (status === "notification_not_sent") return "Relay must send the owner notification test before you can confirm it.";
  if (status === "not_ready") return "Go-live approval is locked until every earlier readiness check is complete.";
  if (status === "invalid_action") return "That onboarding action is not available.";
  return null;
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ onboarding?: string }>;
}) {
  const session = await requireAccountUser();
  const { account, accountId, membershipCount } = session;
  const [onboarding, notices] = await Promise.all([
    loadAccountOnboardingReadiness(accountId),
    searchParams,
  ]);
  const { readiness, evidence, facts } = onboarding;
  const technicalStatus = facts.technicalStatus;
  const a2pStatus = facts.a2pStatus;
  const lastRecoveredCallAt = facts.signedCallVerifiedAt;
  const callsAreLive = technicalStatus === "live";
  const waitingForForwarding = technicalStatus === "waiting_for_forwarding";
  const serviceUnavailable = technicalStatus === "paused" || technicalStatus === "closed";
  const textingIsAvailable = a2pStatus === "approved";
  const textingNeedsAttention = a2pStatus === "rejected" || a2pStatus === "needs_attention" || a2pStatus === "paused";
  const callsLabel = callsAreLive
    ? "Live"
    : waitingForForwarding
      ? "Action needed"
      : serviceUnavailable
        ? technicalStatus === "closed" ? "Closed" : "Paused"
        : "Relay is working";
  const callsDetail = callsAreLive
    ? "A real missed call reached your Relay inbox."
    : waitingForForwarding
      ? "Turn on missed-call forwarding below."
      : serviceUnavailable
        ? "Contact Relay if this is unexpected."
        : "We’ll let you know if we need anything.";
  const textingLabel = account.smsEnabled
    ? "On"
    : textingIsAvailable
      ? "Ready to turn on"
      : textingNeedsAttention
        ? "Relay is resolving this"
        : "Relay is preparing this";
  const textingDetail = account.smsEnabled
    ? "Missed callers receive an automatic text-back."
    : textingIsAvailable
      ? "You can enable automatic text-back in Settings."
      : textingNeedsAttention
        ? "Calls and your inbox continue to work normally."
        : "This happens separately from call setup.";
  const notice = onboardingNotice(notices.onboarding);
  const noticeIsSuccess = notices.onboarding === "notification_confirmed" || notices.onboarding === "approved";
  const approvalReady = readiness.checks.every(
    (check) => check.key === "customer_approval" || check.status === "complete",
  ) && readiness.state !== "blocked";

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
          eyebrow="Relay setup"
          title={
            readiness.ready
              ? "Your account is approved for production"
              : callsAreLive
              ? "Your missed calls are covered"
              : technicalStatus === "closed"
                ? "Account closed"
                : technicalStatus === "paused"
                  ? "Service paused"
                  : waitingForForwarding
                    ? "One step to turn on call capture"
                    : "We’re getting your Relay line ready"
          }
          subtitle={
            readiness.ready
              ? "Every required setup test and your explicit approval are recorded."
              : callsAreLive
              ? "Relay confirmed your inbox with a real missed call. Texting and launch approval are tracked separately."
              : serviceUnavailable
                ? "Contact Relay if you need help with this account."
                : waitingForForwarding
                  ? "Forward the calls you miss. Relay confirms the connection after the first real missed call."
                  : "Nothing is needed from you right now."
          }
        />

        {notice ? (
          <div className={noticeIsSuccess ? "settings-notice" : "intake-error settings-notice"} aria-live="polite">
            {notice}
          </div>
        ) : null}

        <section className="panel customer-setup-overview" aria-label="Relay service status">
          <div className="customer-setup-overview__intro">
            <div>
              <p className="t-eyebrow">Your service</p>
              <h2>{readiness.stateLabel}</h2>
              <p>Launch readiness comes from completed setup evidence, not simply having an account or Relay number.</p>
            </div>
            {readiness.ready ? <span className="readiness__badge"><Icon name="check" size={13} /> Production ready</span> : null}
          </div>
          <dl className="customer-setup-overview__states">
            <div className={callsAreLive ? "customer-setup-overview__state--good" : waitingForForwarding ? "customer-setup-overview__state--attention" : ""}>
              <dt><Icon name="phone" size={16} /> Calls</dt>
              <dd><strong>{callsLabel}</strong><span>{callsDetail}</span></dd>
            </div>
            <div className={account.smsEnabled ? "customer-setup-overview__state--good" : ""}>
              <dt><Icon name="message" size={16} /> Automatic text-back</dt>
              <dd>
                <strong>{textingLabel}</strong>
                <span>{textingDetail}</span>
                {callsAreLive && textingIsAvailable && !account.smsEnabled ? (
                  <Link className="customer-setup-overview__link" href="/settings#texting">Enable text-back <Icon name="arrowRight" size={14} /></Link>
                ) : null}
              </dd>
            </div>
          </dl>
          {callsAreLive && lastRecoveredCallAt ? (
            <p className="customer-setup-overview__confirmation"><Icon name="check" size={13} /> Confirmed {new Date(lastRecoveredCallAt).toLocaleDateString("en-US")}</p>
          ) : null}
        </section>

        <section className="panel customer-onboarding" id="approval" aria-label="Onboarding evidence and approval">
          <header className="customer-onboarding__head">
            <div>
              <p className="t-eyebrow">Your next action</p>
              <h2>{readiness.customerAction.label}</h2>
              <p>{readiness.customerAction.detail}</p>
            </div>
            {readiness.customerAction.href ? (
              <Link className="btn btn-secondary" href={readiness.customerAction.href}>Open next step</Link>
            ) : null}
          </header>

          <ol className="customer-onboarding__checks">
            {readiness.checks.map((check) => (
              <li className={`customer-onboarding__check customer-onboarding__check--${check.status}`} key={check.key}>
                <Icon name={check.status === "complete" ? "check" : check.status === "blocked" ? "alertTriangle" : "clock"} size={14} />
                <span><strong>{check.label}</strong><small>{check.detail}</small></span>
              </li>
            ))}
          </ol>

          {session.role === "owner" && evidence.ownerNotificationSentAt && !evidence.ownerNotificationConfirmedAt ? (
            <form action="/api/onboarding/confirm" method="post" className="customer-onboarding__confirmation">
              <input type="hidden" name="action" value="confirm_owner_notification" />
              <div>
                <strong>Did the owner notification reach you?</strong>
                <label><input type="checkbox" name="confirmation" value="confirmed" required /> I received Relay&apos;s real notification test.</label>
              </div>
              <button className="btn btn-secondary" type="submit">Confirm receipt</button>
            </form>
          ) : null}

          {session.role === "owner" && approvalReady && !evidence.customerGoLiveApprovedAt ? (
            <form action="/api/onboarding/confirm" method="post" className="customer-onboarding__confirmation">
              <input type="hidden" name="action" value="approve_go_live" />
              <div>
                <strong>Final production approval</strong>
                <label><input type="checkbox" name="confirmation" value="confirmed" required /> I reviewed the completed tests and approve Relay going live for this business.</label>
              </div>
              <button className="btn btn-primary" type="submit">Approve go-live</button>
            </form>
          ) : session.role !== "owner" && !evidence.customerGoLiveApprovedAt ? (
            <p className="customer-onboarding__owner-note">The account owner must complete notification confirmation and final go-live approval.</p>
          ) : null}
        </section>

        {serviceUnavailable ? (
          <section className="panel customer-setup-help" aria-label="Service status">
            <div>
              <p className="t-eyebrow">Need help?</p>
              <h2>{technicalStatus === "closed" ? "This account is closed." : "Relay is paused."}</h2>
              <p>Contact Relay if this is unexpected or you want to resume service.</p>
            </div>
            <RelayHelpLink businessName={account.businessName} />
          </section>
        ) : waitingForForwarding ? (
          <section className="panel customer-setup-task" id="forwarding" aria-label="Call forwarding instructions">
            <div className="customer-setup-task__head">
              <div>
                <p className="t-eyebrow">Your next step</p>
                <h2>{account.callMode === "forwarding" ? "Turn on missed-call forwarding" : "Start using your Relay number"}</h2>
                <p>Choose your carrier, then dial the code on your existing business phone.</p>
              </div>
              <RelayHelpLink businessName={account.businessName} />
            </div>
            <CarrierForwarding relayNumber={account.twilioPhoneNumber} />
          </section>
        ) : !callsAreLive ? (
          <section className="panel customer-setup-help" aria-label="Relay setup progress">
            <div>
              <p className="t-eyebrow">Relay&apos;s turn</p>
              <h2>We&apos;re connecting your number and inbox.</h2>
              <p>We&apos;ll show the one phone step here if we need you to do anything.</p>
            </div>
            <span className="readiness__badge"><Icon name="clock" size={13} /> In progress</span>
          </section>
        ) : null}
      </section>
    </main>
  );
}

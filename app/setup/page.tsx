import { AppHeader } from "@/app/leads/_components/app-header";
import { PageHead } from "@/app/leads/_components/page-head";
import { Icon } from "@/components/icon";
import Link from "next/link";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import {
  getA2pRegistrationStatus,
  getAccountTechnicalSetupStatus,
  getLastRecoveredCallAt,
} from "@/lib/supabase";
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

export default async function SetupPage() {
  const session = await requireAccountUser();
  const { account, accountId, membershipCount } = session;
  const [technicalStatus, a2pStatus, lastRecoveredCallAt] = await Promise.all([
    getAccountTechnicalSetupStatus(accountId),
    getA2pRegistrationStatus(accountId),
    getLastRecoveredCallAt(accountId),
  ]);
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
            callsAreLive
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
            callsAreLive
              ? "Relay confirmed your inbox with a real missed call."
              : serviceUnavailable
                ? "Contact Relay if you need help with this account."
                : waitingForForwarding
                  ? "Forward the calls you miss. Relay confirms the connection after the first real missed call."
                  : "Nothing is needed from you right now."
          }
        />

        <section className="panel customer-setup-overview" aria-label="Relay service status">
          <div className="customer-setup-overview__intro">
            <div>
              <p className="t-eyebrow">Your service</p>
              <h2>{callsAreLive ? "Calls are live" : "Calls and texting move independently"}</h2>
            </div>
            {callsAreLive ? <span className="readiness__badge"><Icon name="check" size={13} /> Live</span> : null}
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
          <section className="panel customer-setup-task" aria-label="Call forwarding instructions">
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

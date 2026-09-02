import { AppHeader } from "@/app/leads/_components/app-header";
import { PageHead } from "@/app/leads/_components/page-head";
import { Icon } from "@/components/icon";
import Link from "next/link";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { loadAccountOnboardingReadiness } from "@/lib/onboarding-readiness";
import { deriveOwnerServiceStatus } from "@/lib/owner-service-status";
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
  const { facts } = await loadAccountOnboardingReadiness(accountId);
  const technicalStatus = facts.technicalStatus;
  const a2pStatus = facts.a2pStatus;
  const lastRecoveredCallAt = facts.signedCallVerifiedAt;
  const callsAreLive = technicalStatus === "live";
  const waitingForForwarding = technicalStatus === "waiting_for_forwarding";
  const serviceUnavailable = technicalStatus === "paused" || technicalStatus === "closed";
  const textingIsAvailable = a2pStatus === "approved";
  // Calls, voicemail transcription, and texting are independent facts. The
  // same derivation feeds the inbox status strip so both surfaces agree.
  const serviceStatus = deriveOwnerServiceStatus({
    technicalStatus,
    a2pStatus,
    smsEnabled: account.smsEnabled,
    voicemailTranscriptionEnabled: account.voicemailTranscriptionEnabled,
    transcriptionProviderConfigured: Boolean(env.openaiApiKey),
  });
  const callsLabel = callsAreLive
    ? "Live"
    : waitingForForwarding
      ? "Action needed"
      : serviceUnavailable
        ? technicalStatus === "closed" ? "Closed" : "Paused"
        : "Relay is working";
  const callsDetail = callsAreLive
    ? account.callMode === "forwarding"
      ? "Your phone rings first. Relay answers only the calls you miss."
      : "Calls ring you first, then Relay answers if you do not."
    : waitingForForwarding
      ? "Turn on conditional forwarding below. Your phone will still ring first."
      : serviceUnavailable
        ? "Contact Relay if this is unexpected."
        : "We’ll let you know if we need anything.";
  const textingLabel = serviceStatus.texting.label;
  const textingDetail = serviceStatus.texting.detail;
  const textingNextStep = serviceStatus.texting.owner === "relay" ? serviceStatus.texting.nextStep : null;
  const voicemailLabel = serviceStatus.transcription.label;
  const voicemailDetail = serviceStatus.transcription.detail;
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
              ? "Keep answering calls as usual. When you miss one, Relay answers, records the message, and adds it to your inbox."
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
              <h2>{callsAreLive ? "Missed-call coverage is on" : waitingForForwarding ? "Connect your current number" : "Relay is setting up your line"}</h2>
              <p>Calls and automatic text-back are separate, and so is voicemail, so one can work while another is still being prepared.</p>
            </div>
            {callsAreLive ? <span className="readiness__badge"><Icon name="check" size={13} /> Calls live</span> : null}
          </div>
          <dl className="customer-setup-overview__states">
            <div className={callsAreLive ? "customer-setup-overview__state--good" : waitingForForwarding ? "customer-setup-overview__state--attention" : ""}>
              <dt><Icon name="phone" size={16} /> Calls</dt>
              <dd><strong>{callsLabel}</strong><span>{callsDetail}</span></dd>
            </div>
            <div className={serviceStatus.transcription.tone === "ready" ? "customer-setup-overview__state--good" : ""}>
              <dt><Icon name="sparkle" size={16} /> Voicemail</dt>
              <dd>
                <strong>{voicemailLabel}</strong>
                <span>{voicemailDetail}</span>
              </dd>
            </div>
            <div className={serviceStatus.canTextFromRelay ? "customer-setup-overview__state--good" : ""}>
              <dt><Icon name="message" size={16} /> Automatic text-back</dt>
              <dd>
                <strong>{textingLabel}</strong>
                <span>{textingDetail}</span>
                {textingNextStep ? <span>Calls and your inbox continue to work normally. {textingNextStep}</span> : null}
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
          <section className="panel customer-setup-task" id="forwarding" aria-label="Call forwarding instructions">
            <div className="customer-setup-task__head">
              <div>
                <p className="t-eyebrow">Your next step</p>
                <h2>{account.callMode === "forwarding" ? "Connect your current number" : "Start using your Relay number"}</h2>
                <p>{account.callMode === "forwarding" ? "Turn on conditional forwarding once. Your phone keeps ringing normally; Relay answers only when you miss the call." : "Call the Relay number once and let it go unanswered so we can confirm the inbox."}</p>
              </div>
              <RelayHelpLink businessName={account.businessName} />
            </div>
            <CarrierForwarding relayNumber={account.relayPhoneNumber} />
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

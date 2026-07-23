import { AppHeader } from "@/app/leads/_components/app-header";
import { PageHead } from "@/app/leads/_components/page-head";
import { Icon } from "@/components/icon";
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
  const textingStatus = a2pStatus === "approved"
    ? account.smsEnabled
      ? "Automatic texts are on."
      : "Texting is available and currently off."
    : a2pStatus === "rejected" || a2pStatus === "needs_attention"
      ? "Relay is resolving a texting issue."
      : "Relay is enabling texting. Calls work independently.";

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
          eyebrow="Call setup"
          title={
            callsAreLive
              ? "Calls are live"
              : technicalStatus === "closed"
                ? "Account closed"
                : technicalStatus === "paused"
                  ? "Service paused"
                  : waitingForForwarding
                    ? "Turn on missed-call forwarding"
                    : "Relay is preparing your line"
          }
          subtitle={
            callsAreLive
              ? "Relay caught a real missed call and confirmed your inbox is connected."
              : serviceUnavailable
                ? "Contact Relay if you need help with this account."
                : waitingForForwarding
                  ? "Complete this one phone step. Relay confirms the connection automatically after your first real missed call."
                  : "Nothing is needed from you right now."
          }
        />

        {serviceUnavailable ? (
          <section className="panel setup-panel" aria-label="Service status">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Service status</p>
                <h2 className="t-display">
                  {technicalStatus === "closed" ? "This account is closed." : "Relay is paused."}
                </h2>
                <p className="setup-copy">
                  Contact Relay if this is unexpected or you want to resume service.
                </p>
              </div>
              <RelayHelpLink businessName={account.businessName} />
            </div>
          </section>
        ) : callsAreLive ? (
          <section className="panel setup-panel" aria-label="Calls are live">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Call capture</p>
                <h2 className="t-display">Relay is catching your missed calls.</h2>
                <p className="setup-copy">
                  New missed calls will appear in your inbox so you can follow up quickly.
                </p>
              </div>
              <span className="readiness__badge">
                <Icon name="check" size={13} /> Live
              </span>
            </div>

            <dl className="setup-details" aria-label="Texting status">
              <div>
                <dt>Texting</dt>
                <dd>
                  {textingStatus}
                </dd>
              </div>
              {lastRecoveredCallAt ? (
                <div>
                  <dt>Confirmed</dt>
                  <dd>{new Date(lastRecoveredCallAt).toLocaleDateString("en-US")}</dd>
                </div>
              ) : null}
            </dl>
          </section>
        ) : waitingForForwarding ? (
          <>
            <section className="panel setup-panel" aria-label="Call setup instructions">
              <div className="setup-panel__head">
                <div>
                  <p className="t-eyebrow">Your next step</p>
                  <h2 className="t-display">
                    {account.callMode === "forwarding"
                      ? "Turn on missed-call forwarding."
                      : "Start using your Relay number."}
                  </h2>
                </div>
              </div>

              <p className="setup-copy">
                Choose your phone carrier below and turn on forwarding for calls you do not answer. Relay confirms the connection automatically after the first real missed call.
              </p>
              <CarrierForwarding relayNumber={account.twilioPhoneNumber} />
            </section>

            <section className="panel setup-panel" aria-label="Relay setup help">
              <div className="setup-panel__head">
                <div>
                  <p className="t-eyebrow">Need a hand?</p>
                  <h2 className="t-display">Relay can help set this up.</h2>
                  <p className="setup-copy">
                    Send us a note and we&apos;ll help with your phone carrier or number setup.
                  </p>
                </div>
                <RelayHelpLink businessName={account.businessName} />
              </div>
            </section>
          </>
        ) : (
          <section className="panel setup-panel" aria-label="Relay setup progress">
            <div className="setup-panel__head">
              <div>
                <p className="t-eyebrow">Relay&apos;s turn</p>
                <h2 className="t-display">We&apos;re connecting your number and inbox.</h2>
                <p className="setup-copy">
                  We&apos;ll show the forwarding step here if you need to do anything.
                </p>
              </div>
              <span className="readiness__badge">
                <Icon name="clock" size={13} /> In progress
              </span>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

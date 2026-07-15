import type { ReactNode } from "react";
import Link from "next/link";
import { AppHeader } from "@/app/leads/_components/app-header";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type RunbookSection = {
  eyebrow: string;
  title: string;
  summary: string;
  steps: ReactNode[];
};

const RUNBOOK_SECTIONS: RunbookSection[] = [
  {
    eyebrow: "When something looks wrong",
    title: "Protect the callback first.",
    summary: "If Relay may have missed a text, summary, or save, the safest move is simple: make sure the owner calls the lead.",
    steps: [
      "Search technical logs by caller last 4, call id, message id, recording id, or event type.",
      "Open the lead and check whether SMS, voicemail, transcript, and reply status look complete.",
      "If SMS or transcription may have failed, tell the owner to call the lead manually.",
      "Use caller last 4 and system IDs in support notes instead of full message or transcript text.",
    ],
  },
  {
    eyebrow: "Normal recovery loop",
    title: "What should happen.",
    summary: "This is the core promise: missed call in, lead captured, caller texted, owner able to follow up.",
    steps: [
      "Twilio sends the missed call to the right Relay NW account.",
      "One missed-call lead is created in the owner inbox.",
      "Auto-text sends only when A2P is approved and texting is on.",
      "Delivery updates are saved on the lead and message row.",
      "Caller replies are saved and forwarded to the owner.",
      "Voicemail attaches to the lead, then transcription completes or fails visibly.",
    ],
  },
  {
    eyebrow: "Customer onboarding",
    title: "Move a setup request to a live account.",
    summary: "This is for you as the Relay NW operator. It is not something a contractor customer needs to understand.",
    steps: [
      "Open setup requests from the Relay NW house account and mark each request Contacted, Onboarded, or Closed.",
      <>Create the account with <code>npm run provision:account</code>.</>,
      <>Verify it with <code>npm run verify:account -- &lt;slug&gt;</code>.</>,
      "Confirm Twilio webhooks, A2P status, owner email, and owner phone before giving access.",
      "Use the owner setup page for forwarding codes, the listening test, and the SMS test.",
    ],
  },
  {
    eyebrow: "Before handoff",
    title: "Do not call it live until this passes.",
    summary: "This is the minimum proof that the customer can actually recover a missed call.",
    steps: [
      <>Run <code>npm run verify:account -- &lt;slug&gt;</code>.</>,
      <>Run <code>npm run test:activation</code>.</>,
      "Complete one real missed-call test through Twilio.",
      "Confirm technical logs show voice, SMS status, inbound reply, and recording events.",
    ],
  },
  {
    eyebrow: "Privacy",
    title: "Keep only what you need.",
    summary: "Treat recordings, transcripts, and SMS content like customer data, not debugging decoration.",
    steps: [
      <>Technical webhook logs are sanitized and pruned by <code>WEBHOOK_EVENT_RETENTION_DAYS</code>.</>,
      <>Inbound SMS bodies are pruned by <code>INBOUND_MESSAGE_RETENTION_DAYS</code>.</>,
      "Voicemail recordings, transcripts, and lead records stay until manual deletion or automated recording retention ships.",
      "For support notes, prefer caller last 4 and IDs over full transcript or SMS content.",
    ],
  },
  {
    eyebrow: "Deletion or restore",
    title: "Handle data changes deliberately.",
    summary: "Before deleting or restoring anything, collect enough IDs to prove you are touching the right account.",
    steps: [
      "Before destructive support work, export the affected account, leads, messages, recording metadata, opt-outs, and audit rows.",
      "For deletion requests, identify account slug, lead id, caller phone, recording id, message ids, and opt-out rows.",
      <>After deletion or restore, run <code>npm run verify:account -- &lt;slug&gt;</code> and inspect technical logs.</>,
      "Record what changed using IDs and caller last 4, not full private content unless absolutely needed.",
    ],
  },
];

function RunbookCard({ section }: { section: RunbookSection }) {
  return (
    <article className="panel setup-panel">
      <div className="setup-panel__head">
        <p className="t-eyebrow">{section.eyebrow}</p>
        <h2>{section.title}</h2>
        <p className="setup-copy">{section.summary}</p>
      </div>
      <ol className="setup-status__steps">
        {section.steps.map((step, index) => (
          <li className="setup-status__step" key={index}>
            <span className="setup-status__dot">{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}

export default async function OpsRunbookPage() {
  const session = await requireAccountUser();
  const { account } = session;
  const showSetupRequests = isRelayOperator(session);

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <AppHeader businessName={account.businessName} />

        <div className="ops-toolbar">
          <div>
            <p className="t-eyebrow">Ops tools</p>
            <span>Internal checklist</span>
          </div>
          <div className="ops-toolbar__actions">
            {showSetupRequests ? (
              <Link className="btn btn-secondary btn-sm" href="/ops/setup-requests">Setup requests</Link>
            ) : null}
            <Link className="btn btn-secondary btn-sm" href="/ops">Technical logs</Link>
            <Link className="btn btn-secondary btn-sm" href="/leads">Back to leads</Link>
          </div>
        </div>

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Internal ops</p>
            <h1 className="t-display">Support checklist</h1>
            <p className="leads-subtitle">
              For Relay NW operators. Use this when onboarding a customer or checking whether the missed-call loop worked for {account.businessName}.
            </p>
          </div>
        </div>

        <div className="panel setup-panel setup-panel__head">
          <p className="t-eyebrow">Plain English</p>
          <h2>This page is for you, not the owner.</h2>
          <p className="setup-copy">
            Owners should mostly live in Leads, Setup, Settings, and Reports. This page is the internal checklist for debugging,
            onboarding, privacy, and handoff.
          </p>
        </div>

        <section className="setup-grid">
          {RUNBOOK_SECTIONS.map((section) => (
            <RunbookCard key={section.title} section={section} />
          ))}
        </section>
      </section>
    </main>
  );
}

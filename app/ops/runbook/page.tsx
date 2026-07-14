import Link from "next/link";
import { requireAccountUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function OpsRunbookPage() {
  const { account } = await requireAccountUser();

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Ops runbook</p>
            <h1 className="t-display">Failure checks</h1>
            <p className="leads-subtitle">{account.businessName}</p>
          </div>
          <div className="lead-actions">
            <Link className="btn btn-secondary" href="/ops">Webhook debug</Link>
            <Link className="btn btn-secondary" href="/leads">Back to leads</Link>
          </div>
        </div>

        <section className="setup-grid">
          <article className="panel setup-panel">
            <p className="t-eyebrow">First response</p>
            <h2 className="t-display">Protect the callback.</h2>
            <ol className="setup-status__steps">
              <li>Search webhook debug by CallSid, MessageSid, RecordingSid, source, or caller last 4.</li>
              <li>Open the lead and check SMS, voicemail, transcript, and reply status.</li>
              <li>If SMS or transcription may have failed, tell the owner to call the lead manually.</li>
              <li>Use IDs and caller last 4 in support notes whenever possible.</li>
            </ol>
          </article>

          <article className="panel setup-panel">
            <p className="t-eyebrow">Healthy loop</p>
            <h2 className="t-display">What must happen.</h2>
            <ol className="setup-status__steps">
              <li>Twilio webhook resolves to the account.</li>
              <li>One missed-call lead is created.</li>
              <li>Auto-text sends only when A2P is approved and texting is on.</li>
              <li>SMS status callback updates the lead and message row.</li>
              <li>Caller replies are stored and forwarded to the owner.</li>
              <li>Recording attaches to the lead and transcription completes or fails visibly.</li>
            </ol>
          </article>
        </section>

        <section className="setup-grid">
          <article className="panel setup-panel">
            <p className="t-eyebrow">Retention</p>
            <h2 className="t-display">Keep only what you need.</h2>
            <ul className="setup-status__steps">
              <li>Webhook debug logs are sanitized and pruned by `WEBHOOK_EVENT_RETENTION_DAYS`.</li>
              <li>Inbound SMS bodies are pruned by `INBOUND_MESSAGE_RETENTION_DAYS`.</li>
              <li>Voicemail recordings, transcripts, and lead records are retained until manual deletion or automated recording retention ships.</li>
              <li>Deletion requests require account, lead, caller phone, RecordingSid, MessageSids, and opt-out rows.</li>
            </ul>
          </article>

          <article className="panel setup-panel">
            <p className="t-eyebrow">Release check</p>
            <h2 className="t-display">Before handoff.</h2>
            <ol className="setup-status__steps">
              <li>Run `npm run verify:account -- &lt;slug&gt;`.</li>
              <li>Run `npm run test:activation`.</li>
              <li>Complete one real Twilio missed-call test.</li>
              <li>Confirm webhook debug shows voice, SMS status, inbound reply, and recording events.</li>
            </ol>
          </article>
        </section>
      </section>
    </main>
  );
}

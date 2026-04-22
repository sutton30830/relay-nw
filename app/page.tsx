import Link from "next/link";
import { CopyButton } from "@/app/copy-button";
import { Icon } from "@/components/icon";
import { env } from "@/lib/env";
import { missedCallSmsBody } from "@/lib/twilio";

function StatusDot({ tone }: { tone: "good" | "warn" | "danger" }) {
  return <span className={`s-dot s-dot--${tone}`} />;
}

export default function HomePage() {
  const voiceWebhookUrl = `${env.appBaseUrl}/api/twilio/voice`;
  const smsWebhookUrl = `${env.appBaseUrl}/api/twilio/sms`;
  const smsBody = missedCallSmsBody();

  const healthChecks = [
    { label: "Twilio webhook: Voice", tone: "good" as const, detail: "Ready for inbound calls" },
    { label: "Twilio webhook: SMS", tone: "good" as const, detail: "Ready for replies and opt-outs" },
    { label: "Supabase connection", tone: "good" as const, detail: "Server routes write securely" },
    { label: "A2P 10DLC registration", tone: "warn" as const, detail: "Required before real US customer texting" },
  ];

  const recent = [
    { kind: "missed", text: "Missed calls create a lead and send one auto-text." },
    { kind: "intake", text: "Intake form submissions save to the same lead inbox." },
    { kind: "failed", text: "Failed SMS rows are flagged so the owner can call directly." },
  ];

  return (
    <main className="home-view">
      <header className="app-head">
        <div className="app-head__brand">
          <div className="brand-mark">
            <Icon name="relay" size={18} />
          </div>
          <div>
            <p className="t-eyebrow" style={{ fontSize: 10 }}>Relay NW</p>
            <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>
              {env.businessName}
            </h1>
          </div>
          <span className="live-dot">
            <span className="live-dot__pulse" />
            <span className="live-dot__core" />
            All systems go
          </span>
        </div>
        <div className="app-head__right">
          <Link className="btn btn-secondary btn-sm" href="/intake">
            <Icon name="external" size={13} /> View intake
          </Link>
          <Link className="btn btn-primary btn-sm" href="/leads">
            <Icon name="inbox" size={13} /> Open leads
          </Link>
        </div>
      </header>

      <section className="home-hero">
        <div>
          <p className="t-eyebrow">Your missed-call safety net</p>
          <h2 className="t-display home-hero__title">
            Every missed call gets a warm, useful text back in <em>under 20 seconds.</em>
          </h2>
          <p className="home-hero__sub">
            Calls to your Twilio number ring the owner&apos;s phone. If they cannot pick up,
            Relay NW texts the caller an intake link and saves the lead.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link className="btn btn-primary" href="/leads">
              Open lead inbox <Icon name="arrowRight" size={14} />
            </Link>
            <Link className="btn btn-secondary" href="/intake">
              See the intake form
            </Link>
          </div>
        </div>

        <aside className="phone-mock" aria-label="Missed-call SMS preview">
          <div className="phone-mock__notch" />
          <div className="phone-mock__screen">
            <div className="phone-mock__time">10:42</div>
            <div className="phone-mock__msg-head">
              <div className="phone-mock__avatar">
                {env.businessName
                  .split(" ")
                  .map((word) => word[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>{env.businessName}</p>
                <p style={{ margin: 0, fontSize: 11, color: "var(--ink-4)" }}>Text message</p>
              </div>
            </div>
            <div className="phone-mock__bubble">{smsBody}</div>
            <p className="phone-mock__time-stamp">Sent after missed call</p>
          </div>
        </aside>
      </section>

      <section className="home-grid">
        <div className="panel home-panel">
          <header className="home-panel__head">
            <p className="t-eyebrow">System health</p>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Production ready</span>
          </header>
          <ul className="health-list">
            {healthChecks.map((check) => (
              <li key={check.label} className="health-row">
                <StatusDot tone={check.tone} />
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>{check.label}</p>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)" }}>{check.detail}</p>
                </div>
                <Icon name="chevronRight" size={14} />
              </li>
            ))}
          </ul>
        </div>

        <div className="panel home-panel">
          <header className="home-panel__head">
            <p className="t-eyebrow">Twilio webhooks</p>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>POST only</span>
          </header>
          <div className="grid gap-3">
            <div className="copy-row">
              <div style={{ minWidth: 0, flex: 1 }}>
                <p className="t-eyebrow" style={{ fontSize: 10 }}>Voice: a call comes in</p>
                <p className="t-mono copy-row__value">{voiceWebhookUrl}</p>
              </div>
              <CopyButton value={voiceWebhookUrl} />
            </div>
            <div className="copy-row">
              <div style={{ minWidth: 0, flex: 1 }}>
                <p className="t-eyebrow" style={{ fontSize: 10 }}>Messaging: a text comes in</p>
                <p className="t-mono copy-row__value">{smsWebhookUrl}</p>
              </div>
              <CopyButton value={smsWebhookUrl} />
            </div>
          </div>
          <div className="home-note">
            <Icon name="info" size={14} />
            <p style={{ margin: 0 }}>
              Paste these into your Twilio phone number&apos;s Voice and Messaging webhook fields.
              Method: <span className="t-mono">POST</span>.
            </p>
          </div>
        </div>

        <div className="panel home-panel home-panel--wide">
          <header className="home-panel__head">
            <p className="t-eyebrow">Recent activity</p>
            <Link href="/leads" className="t-eyebrow" style={{ color: "var(--brand)" }}>
              See leads <Icon name="arrowRight" size={11} />
            </Link>
          </header>
          <ul className="activity-list">
            {recent.map((item) => (
              <li key={item.text} className="activity-row">
                <span className={`activity-icon activity-icon--${item.kind}`}>
                  <Icon
                    name={item.kind === "failed" ? "alertTriangle" : item.kind === "intake" ? "inbox" : "phoneMissed"}
                    size={13}
                  />
                </span>
                <span style={{ flex: 1 }}>{item.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel home-panel">
          <header className="home-panel__head">
            <p className="t-eyebrow">SMS template</p>
          </header>
          <div className="sms-preview">
            <p style={{ margin: 0, lineHeight: 1.55 }}>{smsBody}</p>
          </div>
          <div className="home-settings">
            <div className="setting">
              <span className="setting__label">Ring timeout</span>
              <span className="setting__value t-mono">{env.dialTimeoutSeconds}s</span>
            </div>
            <div className="setting">
              <span className="setting__label">SMS cooldown</span>
              <span className="setting__value t-mono">{env.missedCallSmsCooldownHours}h</span>
            </div>
            <div className="setting">
              <span className="setting__label">Twilio number</span>
              <span className="setting__value t-mono">{env.twilioPhoneNumber}</span>
            </div>
          </div>
        </div>

        <div className="panel home-panel home-panel--tip">
          <Icon name="sparkle" size={22} />
          <div>
            <p className="t-eyebrow">Pro tip</p>
            <p style={{ margin: "6px 0 0", fontSize: 14.5, lineHeight: 1.55 }}>
              Put the Twilio number on the truck, business card, and Google listing. Missed calls
              become texted leads automatically.
            </p>
          </div>
        </div>
      </section>

      <footer className="home-footer">
        <span>Relay NW. Built for one business, not a thousand.</span>
        <span>No accounts, no CRM, no extra noise.</span>
      </footer>
    </main>
  );
}

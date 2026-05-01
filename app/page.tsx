import Link from "next/link";
import { Icon } from "@/components/icon";
import { publicBusinessName } from "@/lib/display-name";
import { env } from "@/lib/env";

export default function HomePage() {
  const businessName = publicBusinessName(env.businessName);
  const steps = [
    {
      icon: "phone" as const,
      title: "Keep your number",
      body: "Forward missed, busy, or unreachable calls to Relay NW. Your main number stays the same.",
    },
    {
      icon: "message" as const,
      title: "Text back automatically",
      body: "Instead of hitting voicemail, missed callers get a simple text so they can tell you what they need.",
    },
    {
      icon: "inbox" as const,
      title: "Follow up fast",
      body: "See the caller, voicemail, and next step in one simple inbox.",
    },
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
              {businessName}
            </h1>
          </div>
        </div>
        <div className="app-head__right app-head__right--primary">
          <Link className="btn btn-secondary btn-header" href="#setup">
            <Icon name="settings" size={13} /> View setup
          </Link>
          <Link className="btn btn-primary btn-header" href="/leads">
            <Icon name="inbox" size={13} /> Open inbox
          </Link>
        </div>
      </header>

      <section className="home-hero">
        <div>
          <p className="t-eyebrow">Missed-call follow-up</p>
          <h2 className="t-display home-hero__title">
            Miss a call? That&apos;s a <em>lost job.</em>
          </h2>
          <p className="home-hero__sub">
            When you miss a call, customers move on. Relay NW texts them so you can call back before
            they hire someone else.
          </p>
          <p className="home-hero__sub">
            Setup takes 5-10 minutes. Texting usually goes live once your number is approved.
          </p>
        </div>

        <aside className="phone-mock" aria-label="Missed-call SMS preview">
          <div className="phone-mock__notch" />
          <div className="phone-mock__screen">
            <div className="phone-mock__time">10:42</div>
            <div className="phone-mock__msg-head">
              <div className="phone-mock__avatar">
                {businessName
                  .split(" ")
                  .map((word) => word[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>Relay NW</p>
                <p style={{ margin: 0, fontSize: 11, color: "rgba(255,255,255,0.55)" }}>now</p>
              </div>
            </div>
            <div className="phone-mock__bubble">
              Sorry we missed your call. Text us what you need and we&apos;ll get back to you shortly. Reply STOP to opt out.
            </div>
            <p className="phone-mock__time-stamp">Sent after missed call</p>
          </div>
        </aside>
      </section>

      <section className="client-section" id="setup">
        <div className="client-section__intro">
          <p className="t-eyebrow">How Relay NW works</p>
          <h2 className="t-display">Turn missed calls into real jobs.</h2>
          <p>
            When you&apos;re on a job, driving, or can&apos;t answer, customers move on. Relay NW gives
            them a quick response so you don&apos;t lose the work.
          </p>
        </div>

        <div className="client-steps">
          {steps.map((step, index) => (
            <article key={step.title} className="panel client-step">
              <div className="client-step__top">
                <span className="client-step__number">{index + 1}</span>
                <span className="client-step__icon"><Icon name={step.icon} size={22} /></span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>

        <p className="home-optional">
          Setup takes 5-10 minutes on your end. Texting activation depends on number approval and usually goes live within a day or two.
        </p>
      </section>

      <footer className="home-footer">
        <span>Relay NW. Missed-call recovery for local service businesses.</span>
        <span>Catch the calls you would have lost.</span>
      </footer>
    </main>
  );
}

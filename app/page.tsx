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
      body: "Forward missed, busy, or unreachable calls to Relay NW.",
    },
    {
      icon: "message" as const,
      title: "Greet the caller",
      body: "Relay NW plays your greeting, takes a voicemail, and saves the lead.",
    },
    {
      icon: "inbox" as const,
      title: "Follow up fast",
      body: "Open one simple inbox with the caller, message, and next step.",
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
          <p className="t-eyebrow">Missed-call follow-up</p>
          <h2 className="t-display home-hero__title">
            Keep your number. Catch more <em>missed calls.</em>
          </h2>
          <p className="home-hero__sub">
            Relay NW answers missed calls with your greeting, records the message, and saves the
            caller in one simple inbox.
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
              Sorry we missed your call. Tell us what you need and we will follow up shortly. Reply
              STOP to opt out.
            </div>
            <p className="phone-mock__time-stamp">Sent after missed call</p>
          </div>
        </aside>
      </section>

      <section className="client-section">
        <div className="client-section__intro">
          <p className="t-eyebrow">How it works</p>
          <h2 className="t-display">Set up once. Use it every day.</h2>
          <p>
            Built for local service owners who cannot answer every call. When your number goes
            unanswered, Relay NW gives the caller a clear next step and gives you the lead.
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
      </section>

      <footer className="home-footer">
        <span>Relay NW. Missed-call follow-up for local service businesses.</span>
        <span>Keep your number. Catch the next job.</span>
      </footer>
    </main>
  );
}

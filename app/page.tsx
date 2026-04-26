import Link from "next/link";
import { Icon } from "@/components/icon";
import { publicBusinessName } from "@/lib/display-name";
import { env } from "@/lib/env";

export default function HomePage() {
  const businessName = publicBusinessName(env.businessName);
  const customerPreview =
    "Sorry we missed your call. Tell us what you need and we will follow up shortly. Reply STOP to opt out.";

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

  const benefits = [
    "No phone-number change.",
    "A real greeting instead of a dead end.",
    "One simple inbox for missed calls.",
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
          <div className="mt-5 flex flex-wrap gap-3">
            <Link className="btn btn-primary" href="/leads">
              Get started <Icon name="arrowRight" size={14} />
            </Link>
            <Link className="btn btn-secondary" href="/intake">
              See how it works
            </Link>
          </div>
          <div className="mt-8 grid max-w-2xl gap-5 sm:grid-cols-3">
            {[
              ["phone", "Keep your number", "No website or Google listing change."],
              ["message", "Helpful reply", "Callers know what happens next."],
              ["user", "Faster follow-up", "You stay connected after the ring."],
            ].map(([icon, title, body]) => (
              <div key={title} className="home-hero-stat">
                <Icon name={icon as "phone" | "message" | "user"} size={28} />
                <div>
                  <p>{title}</p>
                  <span>{body}</span>
                </div>
              </div>
            ))}
          </div>
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
            <div className="phone-mock__bubble">{customerPreview}</div>
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

        <div className="client-split">
          <div className="panel client-card client-card--dark">
            <p className="t-eyebrow">What customers experience</p>
            <h3>A clear reply instead of a dead end.</h3>
            <div className="client-sms">
              <div className="client-sms__head">
                <span><Icon name="message" size={15} /></span>
                <strong>{businessName}</strong>
                <em>now</em>
              </div>
              <p>{customerPreview}</p>
            </div>
          </div>

          <div className="panel client-card">
            <p className="t-eyebrow">Why businesses use it</p>
            <h3>More chances to turn calls into work.</h3>
            <ul className="client-benefits">
              {benefits.map((benefit) => (
                <li key={benefit}>
                  <Icon name="check" size={15} />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link className="btn btn-primary" href="/intake">
                View the intake form
              </Link>
              <Link className="btn btn-secondary" href="/leads">
                Open the lead inbox
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="home-footer">
        <span>Relay NW. Missed-call follow-up for local service businesses.</span>
        <span>Keep your number. Catch the next job.</span>
      </footer>
    </main>
  );
}

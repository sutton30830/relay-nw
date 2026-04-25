import Link from "next/link";
import { Icon } from "@/components/icon";
import { env } from "@/lib/env";

export default function HomePage() {
  const customerPreview =
    "Hi, sorry we missed your call. Tell us what you need and we will follow up shortly. Reply STOP to opt out.";

  const steps = [
    {
      icon: "phone" as const,
      title: "Customers call your number",
      body: "You keep the business number already on your website, trucks, and Google profile.",
    },
    {
      icon: "message" as const,
      title: "Missed calls forward to Relay NW",
      body: "Conditional call forwarding sends busy or unanswered calls to your Relay NW recovery number.",
    },
    {
      icon: "inbox" as const,
      title: "They get a useful text",
      body: "Relay NW texts the caller, saves the lead, and gives you a simple follow-up inbox.",
    },
  ];

  const benefits = [
    "Keep the number customers already know.",
    "Recover customers who would have called the next company.",
    "Keep follow-up simple from a phone-friendly lead inbox.",
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
            Keep your number. Text back missed callers <em>automatically.</em>
          </h2>
          <p className="home-hero__sub">
            Relay NW works with conditional call forwarding so local service businesses can keep
            their existing number and still recover missed-call leads.
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
              ["message", "Missed-call text", "Customers get a fast next step."],
              ["user", "More booked work", "You stay connected after the ring."],
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
                {env.businessName
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
          <h2 className="t-display">Simple enough to use on day one.</h2>
          <p>
            Relay NW is built for local service owners who are in the field, on ladders, under
            sinks, or driving between jobs. When your existing number goes unanswered, the follow-up
            still happens.
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
            <h3>A fast, helpful reply instead of a dead end.</h3>
            <div className="client-sms">
              <div className="client-sms__head">
                <span><Icon name="message" size={15} /></span>
                <strong>{env.businessName}</strong>
                <em>now</em>
              </div>
              <p>{customerPreview}</p>
            </div>
          </div>

          <div className="panel client-card">
            <p className="t-eyebrow">Why businesses use it</p>
            <h3>More chances to turn calls into booked work.</h3>
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
        <span>Relay NW. Automatic missed-call texts for local service businesses.</span>
        <span>Keep customers happy. Win more jobs.</span>
      </footer>
    </main>
  );
}

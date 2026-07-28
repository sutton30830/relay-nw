import Link from "next/link";
import { Icon } from "@/components/icon";
import { publicBusinessName } from "@/lib/display-name";
import { env } from "@/lib/env";

const STEPS = [
  {
    number: "01",
    title: "Keep your business number",
    body: "Relay helps you connect missed calls with conditional forwarding.",
  },
  {
    number: "02",
    title: "See every missed-call lead",
    body: "Caller details and voicemail arrive together in a simple inbox.",
  },
  {
    number: "03",
    title: "Follow up from one place",
    body: "Call back quickly, track the outcome, and add automatic text-back after carrier approval.",
  },
];

export default function HomePage() {
  const businessName = publicBusinessName(env.businessName);

  return (
    <main className="home-view">
      <header className="app-head">
        <div className="app-head__brand">
          <div className="brand-mark">
            <Icon name="relay" size={18} />
          </div>
          <div>
            <p className="t-eyebrow app-head__eyebrow">Relay NW</p>
            <h1 className="t-display app-head__name">{businessName}</h1>
          </div>
        </div>
        <div className="app-head__right app-head__right--primary">
          <Link className="text-link home-header__login" href="/login">Sign in</Link>
        </div>
      </header>

      <section className="home-hero">
        <div className="home-hero__copy">
          <p className="t-eyebrow">Missed-call recovery for local trades</p>
          <h2 className="t-display home-hero__title">
            Missed calls,
            <br />
            <em>ready for follow-up.</em>
          </h2>
          <p className="home-hero__sub">
            Relay captures the calls you miss, keeps caller details and voicemail
            together, and gives you one clear place to follow up.
          </p>
          <div className="home-hero__actions">
            <Link className="btn btn-primary home-hero__cta" href="/intake">
              Request setup <Icon name="arrowRight" size={14} />
            </Link>
          </div>
          <p className="home-hero__note">Keep your number. Relay guides you through setup.</p>
        </div>

        <aside className="hero-convo" aria-label="How Relay handles a missed call">
          <p className="hero-convo__event">
            <Icon name="phoneMissed" size={12} /> Missed call · 4:12 PM
          </p>
          <p className="hero-convo__saved">
            <Icon name="check" size={13} /> Lead saved to your inbox
          </p>
          <p className="hero-convo__mode">With automatic text-back enabled</p>
          <div className="hero-convo__msg hero-convo__msg--relay">
            <p className="hero-convo__bubble">
              Sorry we missed your call — text us what you need and we&apos;ll get right back to you.
            </p>
            <span className="hero-convo__meta">Sent after carrier approval</span>
          </div>
          <div className="hero-convo__msg hero-convo__msg--caller">
            <p className="hero-convo__bubble">
              Water heater&apos;s leaking — can someone come out today?
            </p>
            <span className="hero-convo__meta">Customer replies</span>
          </div>
        </aside>
      </section>

      <section className="home-how" id="setup">
        <div className="home-how__intro">
          <p className="t-eyebrow">How Relay works</p>
          <h2 className="t-display">Your next job calls while you&apos;re busy.</h2>
          <p>
            Start with reliable missed-call capture. Add automatic texting separately
            after your business is approved for carrier messaging.
          </p>
        </div>

        <ol className="home-steps">
          {STEPS.map((step) => (
            <li key={step.number} className="home-step">
              <span className="home-step__number t-display">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="home-cta">
        <h2 className="t-display">Make missed calls easier to recover.</h2>
        <p>Tell us about your business. Relay will confirm the fit and guide your setup.</p>
        <Link className="btn btn-primary home-hero__cta" href="/intake">
          Request setup
        </Link>
      </section>
    </main>
  );
}

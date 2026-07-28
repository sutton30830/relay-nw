import Link from "next/link";
import { Icon } from "@/components/icon";
import { InboxLink } from "@/app/inbox-link";
import { publicBusinessName } from "@/lib/display-name";
import { env } from "@/lib/env";

const STEPS = [
  {
    number: "01",
    title: "Forward your missed calls",
    body: "Keep your number. One dial code sends the calls you can't answer to Relay.",
  },
  {
    number: "02",
    title: "Callers get a text in seconds",
    body: "Before they dial the next company, they're already talking to yours.",
  },
  {
    number: "03",
    title: "You call back and win the job",
    body: "The voicemail arrives summarized, with the lead waiting in a simple inbox.",
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
          <Link className="text-link home-header__login" href="/login">Customer sign in</Link>
          <InboxLink className="btn btn-secondary btn-header home-header__inbox">
            <Icon name="inbox" size={13} /> Inbox
          </InboxLink>
        </div>
      </header>

      <section className="home-hero">
        <div className="home-hero__copy">
          <p className="t-eyebrow">Missed-call recovery for local trades</p>
          <h2 className="t-display home-hero__title">
            Miss a call?
            <br />
            That&apos;s a <em>lost job.</em>
          </h2>
          <p className="home-hero__sub">
            Relay answers every call you can&apos;t — an instant text back, the voicemail
            summarized, and the lead waiting in your inbox. You keep your number.
          </p>
          <div className="home-hero__actions">
            <Link className="btn btn-primary home-hero__cta" href="/intake">
              Get started <Icon name="arrowRight" size={14} />
            </Link>
            <p className="home-hero__owner-link">
              Already using Relay? <Link className="text-link" href="/login">Sign in</Link> · <InboxLink className="text-link">Open your inbox</InboxLink>
            </p>
          </div>
          <p className="home-hero__note">Request a Relay account for your business · $99/month · first 30 days free</p>
        </div>

        {/* The product loop in one glance: missed call → instant text → the
            customer stays yours. Styled like a real thread, not a fake phone. */}
        <aside className="hero-convo" aria-label="What a caller sees after a missed call">
          <p className="hero-convo__event">
            <Icon name="phoneMissed" size={12} /> Missed call · 4:12 PM
          </p>
          <div className="hero-convo__msg hero-convo__msg--relay">
            <p className="hero-convo__bubble">
              Sorry we missed your call — text us what you need and we&apos;ll get right back to you.
            </p>
            <span className="hero-convo__meta">Sent by Relay, seconds later</span>
          </div>
          <div className="hero-convo__msg hero-convo__msg--caller">
            <p className="hero-convo__bubble">
              Water heater&apos;s leaking — can someone come out today?
            </p>
            <span className="hero-convo__meta">Customer replies</span>
          </div>
          <p className="hero-convo__saved">
            <Icon name="check" size={13} /> Lead saved to your inbox
          </p>
        </aside>
      </section>

      <section className="home-how" id="setup">
        <div className="home-how__intro">
          <p className="t-eyebrow">How Relay works</p>
          <h2 className="t-display">Your next job calls while you&apos;re busy.</h2>
          <p>
            Under a sink, driving between houses, or closed for the day — if nobody answers,
            that customer calls the next company. Relay keeps them with you.
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
        <h2 className="t-display">Stop losing calls you already earned.</h2>
        <p>If Relay doesn&apos;t help you recover missed calls, you don&apos;t pay.</p>
        <Link className="btn btn-primary home-hero__cta" href="/intake">
          Get started
        </Link>
      </section>
    </main>
  );
}

import Link from "next/link";
import { Icon } from "@/components/icon";
import { publicBusinessName } from "@/lib/display-name";
import { env } from "@/lib/env";

export default function HomePage() {
  const businessName = publicBusinessName(env.businessName);
  const steps = [
    {
      icon: "phone" as const,
      title: "Forward missed calls",
      body: "Keep your number. Send unanswered calls to Relay.",
    },
    {
      icon: "message" as const,
      title: "We text them instantly",
      body: "They get a reply before they call someone else.",
    },
    {
      icon: "inbox" as const,
      title: "You win the job",
      body: "Call back fast and turn the request into work.",
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
          <Link className="btn btn-primary btn-header" href="/intake">
            <Icon name="settings" size={13} /> Start catching missed calls
          </Link>
          <Link className="btn btn-secondary btn-header" href="/leads">
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
            Turn missed calls into booked jobs automatically. Relay NW texts callers right away so
            they don&apos;t hire someone else.
          </p>
          <div className="home-hero__actions">
            <Link className="btn btn-primary" href="/intake">
              <Icon name="settings" size={14} /> Start catching missed calls - $99/month
            </Link>
          </div>
          <p className="home-hero__note">
            Takes 5–10 minutes to set up. Texting goes live within 1–2 days.
          </p>
          <p className="home-hero__note">
            Try it for 30 days. If it doesn&apos;t help, we&apos;ll refund you.
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
          <p className="t-eyebrow">Built for busy trades</p>
          <h2 className="t-display">Your next job will call while you&apos;re busy.</h2>
          <p>
            You&apos;re under a sink, driving to the next house, or closed for the day. If nobody
            answers, that customer may call the next company. Relay keeps them with you.
          </p>
        </div>

        <p className="t-eyebrow">How Relay NW works</p>
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

        <div className="home-optional">
          <strong>Start turning missed calls into jobs today</strong>
          <span>$99/month. No contracts. Cancel anytime.</span>
          <span>Try it for 30 days. If it doesn&apos;t help, we&apos;ll refund you.</span>
          <span>Missed call → instant text → customer replies → you call back → job booked.</span>
          <p className="home-optional__punch">Every missed call is a job someone else takes.</p>
          <Link className="btn btn-primary home-optional__cta" href="/intake">
            Start catching missed calls
          </Link>
        </div>
      </section>
    </main>
  );
}

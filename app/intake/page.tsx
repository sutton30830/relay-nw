import Link from "next/link";
import { Icon } from "@/components/icon";
import { IntakeForm } from "@/app/intake/intake-form";
import { env } from "@/lib/env";

type SearchParams = Promise<{
  saved?: string;
  error?: string;
}>;

export default async function IntakePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const saved = params.saved === "1";
  const error = params.error === "1";

  if (saved) {
    return (
      <main className="intake-view intake-view--done">
        <section className="intake-done">
          <div className="intake-done__seal">
            <Icon name="check" size={30} />
          </div>
          <p className="t-eyebrow">Received · just now</p>
          <h1 className="t-display intake-done__title">Thanks. We&apos;ve got you.</h1>
          <p className="intake-done__sub">
            {env.businessName} will call or text you back shortly. If it is urgent, you can also
            book a time directly.
          </p>

          <div className="intake-done__next">
            <h2 className="t-eyebrow">What happens next</h2>
            <ol className="intake-next-list">
              <li><span>1</span> Your request is saved and flagged as new.</li>
              <li><span>2</span> The owner reviews it and reaches out.</li>
              <li><span>3</span> You lock in a time that works.</li>
            </ol>
          </div>

          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <a className="btn btn-primary" href={env.schedulingUrl}>
              <Icon name="calendar" size={14} /> Book a time directly
            </a>
            <Link className="btn btn-secondary" href="/intake">
              Submit another request
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="intake-view">
      <header className="intake-top">
        <div className="app-head__brand">
          <div className="brand-mark">
            <Icon name="relay" size={18} />
          </div>
          <div>
            <Link href="/" className="t-eyebrow" style={{ fontSize: 10 }}>
              Request help
            </Link>
            <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>
              {env.businessName}
            </h1>
          </div>
        </div>
        <a href={env.schedulingUrl} className="btn btn-secondary btn-sm">
          <Icon name="calendar" size={13} /> Book online instead
        </a>
      </header>

      <div className="intake-grid">
        <aside className="intake-side">
          <p className="t-eyebrow">Tell us the essentials</p>
          <h2 className="t-display intake-side__title">
            A few details are all we need to call you back.
          </h2>
          <p className="intake-side__lede">
            Missed our call? Hate phone tag? Fill this out and the owner will follow up by text or
            phone, whichever gets the job moving.
          </p>

          <ul className="intake-signals">
            <li>
              <span className="intake-signals__icon"><Icon name="shield" size={14} /></span>
              <div>
                <p className="intake-signals__t">Your info stays private</p>
                <p className="intake-signals__d">Only used to follow up on this request.</p>
              </div>
            </li>
            <li>
              <span className="intake-signals__icon"><Icon name="clock" size={14} /></span>
              <div>
                <p className="intake-signals__t">Fast follow-up</p>
                <p className="intake-signals__d">The request lands in the owner&apos;s lead inbox.</p>
              </div>
            </li>
            <li>
              <span className="intake-signals__icon"><Icon name="star" size={14} /></span>
              <div>
                <p className="intake-signals__t">Local business friendly</p>
                <p className="intake-signals__d">No account needed. No app to download.</p>
              </div>
            </li>
          </ul>

          <div className="intake-quote">
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, fontStyle: "italic" }}>
              &quot;Texted after a missed call and got a reply without waiting on hold.&quot;
            </p>
            <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--ink-3)" }}>
              Customer-friendly follow-up, built for service work.
            </p>
          </div>
        </aside>

        <section className="intake-form panel">
          <div className="intake-form__head">
            <p className="t-eyebrow">Service request</p>
            <h2 className="t-display intake-form__title">What can we help with?</h2>
          </div>

          <div className="intake-form__body">
            {error ? (
              <div className="intake-error" role="alert">
                <Icon name="alertTriangle" size={14} />
                Something went wrong. Please check the form and try again.
              </div>
            ) : null}
            <IntakeForm />
          </div>
        </section>
      </div>
    </main>
  );
}

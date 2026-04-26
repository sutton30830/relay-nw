import Link from "next/link";
import { Icon } from "@/components/icon";
import { IntakeForm } from "@/app/intake/intake-form";
import { publicBusinessName } from "@/lib/display-name";
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
  const businessName = publicBusinessName(env.businessName);

  if (saved) {
    return (
      <main className="intake-view intake-view--done">
        <section className="intake-done">
          <div className="intake-done__seal">
            <Icon name="check" size={30} />
          </div>
          <p className="t-eyebrow">Request sent</p>
          <h1 className="t-display intake-done__title">We&apos;ve got it.</h1>
          <p className="intake-done__sub">
            {businessName} will call or text you soon. If it is urgent, you can also book a time.
          </p>

          <div className="intake-done__next">
            <h2 className="t-eyebrow">What happens next</h2>
            <ol className="intake-next-list">
              <li><span>1</span> Your request is saved.</li>
              <li><span>2</span> The owner reviews it.</li>
              <li><span>3</span> They follow up.</li>
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
        <Link className="app-head__brand app-head__brand--link" href="/">
          <div className="brand-mark">
            <Icon name="relay" size={18} />
          </div>
          <div>
            <p className="t-eyebrow" style={{ fontSize: 10, margin: 0 }}>
              Request help
            </p>
            <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>
              {businessName}
            </h1>
          </div>
        </Link>
        <a href={env.schedulingUrl} className="btn btn-ghost btn-sm">
          <Icon name="calendar" size={13} /> Book online instead
        </a>
      </header>

      <div className="intake-grid">
        <aside className="intake-side">
          <p className="t-eyebrow">Quick request</p>
          <h2 className="t-display intake-side__title">
            Tell us what you need.
          </h2>
          <p className="intake-side__lede">
            Leave your name, number, and a quick note. We&apos;ll follow up by text or phone.
          </p>

          <ul className="intake-signals">
            <li>
              <span className="intake-signals__icon"><Icon name="shield" size={14} /></span>
              <div>
                <p className="intake-signals__t">Private</p>
                <p className="intake-signals__d">Only used for this request.</p>
              </div>
            </li>
            <li>
              <span className="intake-signals__icon"><Icon name="clock" size={14} /></span>
              <div>
                <p className="intake-signals__t">Fast follow-up</p>
                <p className="intake-signals__d">Goes straight to the inbox.</p>
              </div>
            </li>
            <li>
              <span className="intake-signals__icon"><Icon name="star" size={14} /></span>
              <div>
                <p className="intake-signals__t">No account</p>
                <p className="intake-signals__d">No account needed. No app to download.</p>
              </div>
            </li>
          </ul>

          <div className="intake-quote">
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, fontStyle: "italic" }}>
              &quot;Send the request once. Get a real follow-up.&quot;
            </p>
            <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--ink-3)" }}>
              Built for local service calls.
            </p>
          </div>
          <a href={env.schedulingUrl} className="btn btn-secondary mt-5">
            <Icon name="calendar" size={14} /> Prefer to book directly?
          </a>
        </aside>

        <section className="intake-form panel">
          <div className="intake-form__head">
            <p className="t-eyebrow">Service request</p>
            <h2 className="t-display intake-form__title">How can we help?</h2>
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

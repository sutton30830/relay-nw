import Link from "next/link";
import { Icon } from "@/components/icon";
import { IntakeForm } from "@/app/intake/intake-form";

type SearchParams = Promise<{
  saved?: string;
  error?: string;
  rate_limited?: string;
}>;

export default async function IntakePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const saved = params.saved === "1";
  const error = params.error === "1";
  const rateLimited = params.rate_limited === "1";

  if (saved) {
    return (
      <main className="intake-view intake-view--done">
        <section className="intake-done">
          <div className="intake-done__seal">
            <Icon name="check" size={30} />
          </div>
          <p className="t-eyebrow">Setup request sent</p>
          <h1 className="t-display intake-done__title">Got it.</h1>
          <p className="intake-done__sub">
            We&apos;ll review your setup and reach out shortly.
          </p>

          <div className="intake-done__actions">
            <Link className="btn btn-primary" href="/">
              Back to home
            </Link>
            <Link className="btn btn-secondary" href="/intake">
              Submit another business
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="intake-view">
      {/* Brand only — the page title lives in the intro below, so the header
          doesn't repeat it. */}
      <header className="intake-top">
        <Link className="app-head__brand app-head__brand--link" href="/">
          <div className="brand-mark">
            <Icon name="relay" size={18} />
          </div>
          <h1 className="t-display app-head__name">Relay NW</h1>
        </Link>
      </header>

      <section className="intake-shell">
        <div className="intake-shell__intro">
          <p className="t-eyebrow">Setup request</p>
          <h2 className="t-display intake-side__title">Set up Relay NW</h2>
          <p className="intake-side__lede">
            Takes about 5-10 minutes. We&apos;ll handle the rest and notify you when texting is approved.
          </p>
        </div>

        <section className="intake-form panel">
          <div className="intake-form__head">
            <p className="t-eyebrow">Business info</p>
            <h2 className="t-display intake-form__title">Tell us where to start.</h2>
          </div>

          <div className="intake-form__body">
            {rateLimited ? (
              <div className="intake-error" role="alert">
                <Icon name="alertTriangle" size={14} />
                Too many setup requests came in from this connection. Please wait a bit and try again.
              </div>
            ) : null}
            {error ? (
              <div className="intake-error" role="alert">
                <Icon name="alertTriangle" size={14} />
                Something went wrong. Please check the required fields and try again.
              </div>
            ) : null}
            <IntakeForm />
          </div>
        </section>
      </section>
    </main>
  );
}

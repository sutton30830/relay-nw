import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next || "/leads";
  const alreadySent = params.sent === "recent";
  const rateLimited = params.error === "rate_limited";
  const emailError = params.error === "email";
  const genericError = params.error && !rateLimited && !emailError;

  return (
    <main className="gate-view">
      <section className="gate-card">
        <p className="t-eyebrow" style={{ marginTop: 14 }}>Relay NW · Protected</p>
        <h1 className="t-display gate-title">Owner sign in</h1>
        <p className="gate-sub">Enter the email connected to your Relay NW account.</p>

        {params.sent ? (
          <p className="gate-sub">
            <strong>{alreadySent ? "Use the latest email link." : "Check your email."}</strong>{" "}
            {alreadySent
              ? "A sign-in link was already requested a moment ago. To avoid a temporary lockout, wait about a minute before asking for another one."
              : "Your secure sign-in link is on the way."}
          </p>
        ) : null}

        {params.error ? (
          <p className="gate-sub">
            <strong>{rateLimited ? "Too many sign-in link requests." : emailError ? "Enter your email." : "Sign-in failed."}</strong>{" "}
            {rateLimited
              ? "Use the most recent email link if it arrived, or wait a minute before requesting another one."
              : emailError
                ? "Use the email connected to your Relay NW account."
                : genericError
                  ? "Try again or confirm this email is invited."
                  : null}
          </p>
        ) : null}

        <form action="/api/auth/login" method="POST" className="gate-form">
          <input type="hidden" name="next" value={next} />
          <label className="field-label">
            <span>Email</span>
            <div className="gate-input">
              <input
                className="field"
                name="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                placeholder="owner@example.com"
              />
            </div>
          </label>
          <button className="btn btn-primary" type="submit" style={{ width: "100%", marginTop: 12 }}>
            Send sign-in link
          </button>
        </form>

        <p className="gate-foot">
          <Link href="/" style={{ textDecoration: "underline" }}>Back to setup</Link>
        </p>
      </section>
    </main>
  );
}

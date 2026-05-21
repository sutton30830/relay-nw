import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next || "/leads";

  return (
    <main className="gate-view">
      <section className="gate-card">
        <p className="t-eyebrow" style={{ marginTop: 14 }}>Relay NW · Protected</p>
        <h1 className="t-display gate-title">Owner sign in</h1>
        <p className="gate-sub">Enter the email connected to your Relay NW account.</p>

        {params.sent ? (
          <p className="gate-sub"><strong>Check your email.</strong> Your secure sign-in link is on the way.</p>
        ) : null}

        {params.error ? (
          <p className="gate-sub"><strong>Sign-in failed.</strong> Try again or confirm this email is invited.</p>
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

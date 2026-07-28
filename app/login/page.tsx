import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; reset?: string; error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next || "/leads";
  const alreadySent = params.sent === "recent";
  const rateLimited = params.error === "rate_limited";
  const emailError = params.error === "email";
  const passwordError = params.error === "password";
  const passwordMissing = params.error === "password_missing";
  const resetError = params.error === "reset";
  const sessionExpired = params.error === "session_expired";
  const notInvited = params.error === "not_invited";
  const shouldPauseRequests = Boolean(params.sent) || rateLimited;
  const errorTitle = rateLimited
    ? "Too many sign-in link requests."
    : emailError
      ? "Enter your email."
      : passwordMissing
        ? "Email and password are required."
        : passwordError
          ? "Password sign-in failed."
          : resetError
            ? "Password setup email failed."
            : sessionExpired
              ? "Session expired."
              : notInvited
                ? "This email is not invited."
                : params.error
                  ? "Sign-in failed."
                  : null;
  const errorCopy = rateLimited
    ? "Supabase is temporarily blocking new sign-in emails. Use the most recent email link if it arrived, or wait about 10 minutes before requesting another one."
    : emailError
      ? "Use the email connected to your Relay NW account."
      : passwordMissing
        ? "Enter both fields and try again."
        : passwordError
          ? "Check the password, or use “Forgot or create password?” below."
          : resetError
            ? "Wait a few minutes before requesting another setup email."
            : sessionExpired
              ? "Request a fresh setup link and try again."
              : notInvited
                ? "Ask Relay NW to add this email to the account."
                : params.error
                  ? "Try again or confirm this email is invited."
                  : null;

  return (
    <main className="gate-view">
      <section className="gate-card">
        <p className="t-eyebrow gate-eyebrow">Relay NW · Protected</p>
        <h1 className="t-display gate-title">Owner sign in</h1>
        <p className="gate-sub">Use the email and password connected to your Relay NW account.</p>
        <p className="gate-sub">New to Relay? <Link className="text-link" href="/intake">Request setup</Link>.</p>

        {params.sent ? (
          <p className="gate-sub">
            <strong>{alreadySent ? "Use the latest magic link." : "Check your email."}</strong>{" "}
            {alreadySent
              ? "A sign-in link was already requested recently. To avoid a temporary lockout, wait about 10 minutes before asking for another one."
              : "Your secure sign-in link is on the way. Use the newest email link, and avoid requesting another unless this one never arrives."}
          </p>
        ) : null}

        {params.reset ? (
          <p className="gate-sub">
            <strong>Check your email.</strong> Your password setup link is on the way.
          </p>
        ) : null}

        {params.error ? (
          <p className="gate-sub">
            <strong>{errorTitle}</strong> {errorCopy}
          </p>
        ) : null}

        {/* Primary: email + password. */}
        <form action="/api/auth/password-login" method="POST" className="gate-form">
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

          <label className="field-label">
            <span>Password</span>
            <div className="gate-input">
              <input
                className="field"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="Your password"
              />
            </div>
          </label>

          <button className="btn btn-primary gate-submit" type="submit">
            Sign in
          </button>
        </form>

        {/* One recovery path — opens automatically after a failed sign-in or when
            a setup link was just requested. */}
        <details className="gate-disclosure" open={passwordError || resetError || Boolean(params.reset)}>
          <summary>Forgot your password or signing in for the first time?</summary>
          <form action="/api/auth/password-reset" method="POST" className="gate-form">
            <input type="hidden" name="next" value="/account/password" />
            <p className="gate-hint">We&apos;ll email a link to set a new password.</p>
            <label className="field-label">
              <span>Email</span>
              <div className="gate-input">
                <input
                  className="field"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="owner@example.com"
                />
              </div>
            </label>
            <button className="btn btn-secondary gate-submit-secondary" type="submit">
              Email setup link
            </button>
          </form>
        </details>

        {/* Backup only — quietly available behind a disclosure. */}
        <details className="gate-disclosure" open={rateLimited || Boolean(params.sent)}>
          <summary>Other sign-in options</summary>
          <form action="/api/auth/login" method="POST" className="gate-form">
            <input type="hidden" name="next" value={next} />
            <p className="gate-hint">Sign in with a one-time magic link instead of a password.</p>
            <label className="field-label">
              <span>Email</span>
              <div className="gate-input">
                <input
                  className="field"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="owner@example.com"
                />
              </div>
            </label>
            <button className="btn btn-secondary gate-submit-secondary" type="submit" disabled={shouldPauseRequests}>
              {shouldPauseRequests ? "Use the latest magic link" : "Email one-time magic link"}
            </button>
          </form>
        </details>

        <p className="gate-foot">
          <Link className="text-link" href="/">Back to home</Link>
        </p>
      </section>
    </main>
  );
}

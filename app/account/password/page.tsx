import Link from "next/link";
import { requireAccountUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

function errorMessage(error?: string) {
  if (error === "short") return "Use at least 8 characters.";
  if (error === "mismatch") return "The two passwords did not match.";
  if (error === "save_failed") return "Relay could not save that password. Try again.";
  return null;
}

export default async function PasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [session, params] = await Promise.all([requireAccountUser(), searchParams]);
  const error = errorMessage(params.error);

  return (
    <main className="gate-view">
      <section className="gate-card">
        <p className="t-eyebrow" style={{ marginTop: 14 }}>{session.account.businessName} · Password</p>
        <h1 className="t-display gate-title">Set your password</h1>
        <p className="gate-sub">Use this password for fast owner sign-in without waiting on email links.</p>

        {error ? (
          <p className="gate-sub">
            <strong>Password not saved.</strong> {error}
          </p>
        ) : null}

        <form action="/api/auth/update-password" method="POST" className="gate-form">
          <label className="field-label">
            <span>New password</span>
            <div className="gate-input">
              <input
                className="field"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                placeholder="At least 8 characters"
              />
            </div>
          </label>

          <label className="field-label">
            <span>Confirm password</span>
            <div className="gate-input">
              <input
                className="field"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                placeholder="Re-enter password"
              />
            </div>
          </label>

          <button className="btn btn-primary" type="submit" style={{ width: "100%", marginTop: 12 }}>
            Save password
          </button>
        </form>

        <p className="gate-foot">
          <Link href="/leads" style={{ textDecoration: "underline" }}>Back to inbox</Link>
        </p>
      </section>
    </main>
  );
}

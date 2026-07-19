import Link from "next/link";

export const dynamic = "force-dynamic";

function safeNext(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/account/password";
  }

  return value;
}

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; next?: string }>;
}) {
  const params = await searchParams;
  const tokenHash = params.token_hash ?? "";
  const next = safeNext(params.next);
  const isRecovery = params.type === "recovery";
  const canContinue = Boolean(tokenHash && isRecovery);

  return (
    <main className="gate-view">
      <section className="gate-card">
        <p className="t-eyebrow gate-eyebrow">Relay NW · Protected</p>
        <h1 className="t-display gate-title">Continue setup</h1>
        <p className="gate-sub">
          {canContinue
            ? "Press continue to open your secure password setup."
            : "This setup link is missing required information. Request a fresh link from sign in."}
        </p>

        {canContinue ? (
          <form action="/api/auth/recovery" method="POST" className="gate-form">
            <input type="hidden" name="token_hash" value={tokenHash} />
            <input type="hidden" name="type" value="recovery" />
            <input type="hidden" name="next" value={next} />
            <button className="btn btn-primary gate-submit" type="submit">
              Continue
            </button>
          </form>
        ) : null}

        <p className="gate-foot">
          <Link className="text-link" href="/login">Back to sign in</Link>
        </p>
      </section>
    </main>
  );
}

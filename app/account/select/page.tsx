import { redirect } from "next/navigation";
import { getAccountUserResolution } from "@/lib/auth";

export const dynamic = "force-dynamic";

function safeNext(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/leads";
  }

  return raw;
}

export default async function SelectAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const resolution = await getAccountUserResolution();

  if (resolution.status === "unauthenticated") {
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  if (resolution.status === "no_membership") {
    redirect(`/login?error=not_invited&next=${encodeURIComponent(next)}`);
  }

  if (resolution.status === "single_account" || resolution.status === "selected_account") {
    redirect(next);
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="t-eyebrow">Choose business</p>
        <h1 className="t-display auth-card__title">Select which Relay account to open.</h1>
        <p className="auth-card__copy">
          This sign-in is linked to more than one business. Account selection is being finished in
          the next setup step, so Relay support should choose the account before continuing.
        </p>
      </section>
    </main>
  );
}

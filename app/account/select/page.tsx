import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  createSupabaseAuthServerClient,
  getAccountMembershipsForUser,
  readSelectedAccountCookie,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

function safeNext(value: string | string[] | undefined | null) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/leads";
  }

  return raw;
}

function errorCopy(error: string | string[] | undefined) {
  const code = Array.isArray(error) ? error[0] : error;

  if (code === "invalid") {
    return "That business is not connected to this sign-in anymore. Choose another business to continue.";
  }

  if (code === "missing") {
    return "Choose a business before continuing.";
  }

  return null;
}

export default async function SelectAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const supabase = await createSupabaseAuthServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const memberships = await getAccountMembershipsForUser(data.user);

  if (memberships.length === 0) {
    redirect(`/login?error=not_invited&next=${encodeURIComponent(next)}`);
  }

  if (memberships.length === 1) {
    redirect(next);
  }

  const selectedAccount = readSelectedAccountCookie(await cookies());
  const selectedMembership = memberships.find(
    (membership) =>
      membership.accountId === selectedAccount ||
      membership.account.accountSlug === selectedAccount,
  );
  const message = errorCopy(params.error);

  return (
    <main className="auth-page">
      <section className="auth-card account-select-card">
        <p className="t-eyebrow">Choose business</p>
        <h1 className="t-display auth-card__title">Which inbox do you want to open?</h1>
        <p className="auth-card__copy">
          This sign-in can access more than one Relay account. Pick the business you want to work in.
        </p>

        {message ? (
          <div className="panel settings-notice settings-notice--warn" role="alert">
            {message}
          </div>
        ) : null}

        <div className="account-select-list">
          {memberships.map((membership) => {
            const selected = selectedMembership?.accountId === membership.accountId;

            return (
              <form key={membership.membershipId} action="/api/auth/select-account" method="POST">
                <input type="hidden" name="accountId" value={membership.accountId} />
                <input type="hidden" name="next" value={next} />
                <button className="account-choice" type="submit" aria-current={selected ? "true" : undefined}>
                  <span className="account-choice__avatar">
                    {membership.account.businessName.trim().charAt(0).toUpperCase() || "R"}
                  </span>
                  <span className="account-choice__main">
                    <strong>{membership.account.businessName}</strong>
                    <span>
                      {membership.role.charAt(0).toUpperCase() + membership.role.slice(1)}
                      {selected ? " · Current business" : ""}
                    </span>
                  </span>
                  <span className="account-choice__action">{selected ? "Open" : "Choose"}</span>
                </button>
              </form>
            );
          })}
        </div>
      </section>
    </main>
  );
}

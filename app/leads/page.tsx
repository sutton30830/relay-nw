import { cookies } from "next/headers";
import Link from "next/link";
import { getLeads } from "@/lib/supabase";
import { env } from "@/lib/env";
import { LeadsList } from "@/app/leads/leads-list";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const cookieStore = await cookies();
  const isAllowed = cookieStore.get("relay_leads_password")?.value === env.leadsPassword;

  if (!isAllowed) {
    return (
      <main className="shell">
        <section className="panel mx-auto mt-8 max-w-md p-6 sm:p-8">
          <p className="eyebrow">Relay NW</p>
          <h1 className="mt-3 text-3xl font-semibold">Lead inbox</h1>
          <p className="mt-3 leading-7 text-[var(--muted)]">
            Enter the shared password to open {env.businessName}&apos;s leads.
          </p>
          <form action="/api/leads-login" method="POST" className="mt-7 space-y-4">
            <label className="block">
              <span className="mb-2 block font-semibold">Password</span>
              <input
                className="field"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
              />
            </label>
            <button type="submit" className="button-primary w-full">
              Open leads
            </button>
          </form>
          <p className="mt-6 text-center text-sm text-[var(--muted)]">
            <Link href="/" className="underline-offset-4 hover:underline">
              Back to setup
            </Link>
          </p>
        </section>
      </main>
    );
  }

  const leads = await getLeads();

  return (
    <main className="shell">
      <section className="page">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div>
            <div className="flex items-center gap-2">
              <Link href="/" className="eyebrow">
                Relay NW
              </Link>
              <span
                aria-label="Live — updates automatically"
                title="Auto-refreshes every 30 seconds"
                className="inline-flex items-center gap-1.5 rounded-full bg-[#e4f0e8] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--good)]"
              >
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--good)] opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--good)]" />
                </span>
                Live
              </span>
            </div>
            <h1 className="mt-2 text-3xl font-semibold">Lead inbox</h1>
            <p className="mt-1 text-[var(--muted)]">{env.businessName}</p>
          </div>
          <form action="/api/leads-logout" method="POST">
            <button className="button-secondary">Log out</button>
          </form>
        </div>

        <LeadsList leads={leads} />
      </section>
    </main>
  );
}

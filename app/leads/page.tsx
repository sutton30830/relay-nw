import { cookies } from "next/headers";
import { getLeads } from "@/lib/supabase";
import { env } from "@/lib/env";
import { LeadsList } from "@/app/leads/leads-list";

export default async function LeadsPage() {
  const cookieStore = await cookies();
  const isAllowed = cookieStore.get("relay_leads_password")?.value === env.leadsPassword;

  if (!isAllowed) {
    return (
      <main className="shell">
        <section className="panel mx-auto max-w-md p-6 sm:p-8">
          <p className="eyebrow">Relay NW</p>
          <h1 className="mt-3 text-3xl font-semibold">Lead inbox</h1>
          <p className="mt-3 leading-7 text-[var(--muted)]">Enter the leads password.</p>
          <form action="/api/leads-login" method="POST" className="mt-7 space-y-4">
            <label className="block">
              <span className="mb-2 block font-semibold">Password</span>
              <input className="field" name="password" type="password" required />
            </label>
            <button type="submit" className="button-primary w-full">
              Open leads
            </button>
          </form>
        </section>
      </main>
    );
  }

  const leads = await getLeads();

  return (
    <main className="shell">
      <section className="page">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div>
            <p className="eyebrow">Relay NW</p>
            <h1 className="mt-2 text-3xl font-semibold">Lead inbox</h1>
            <p className="mt-2 text-[var(--muted)]">{env.businessName}</p>
          </div>
          <form action="/api/leads-logout" method="POST">
            <button className="button-secondary">
              Log out
            </button>
          </form>
        </div>

        <LeadsList leads={leads} />
      </section>
    </main>
  );
}

import { cookies } from "next/headers";
import { getLeads } from "@/lib/supabase";
import { env } from "@/lib/env";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

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
  const missedCallCount = leads.filter((lead) => lead.source === "missed_call").length;
  const intakeCount = leads.filter((lead) => lead.source === "intake_form").length;

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

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {[
            ["Total leads", String(leads.length)],
            ["Missed calls", String(missedCallCount)],
            ["Intake forms", String(intakeCount)],
          ].map(([label, value]) => (
            <div key={label} className="panel p-5">
              <p className="text-sm font-semibold text-[var(--muted)]">{label}</p>
              <p className="mt-2 text-3xl font-semibold">{value}</p>
            </div>
          ))}
        </div>

        <div className="panel mt-6 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[#f1eee7] text-sm text-[var(--muted)]">
                <th className="p-4">Created</th>
                <th className="p-4">Name</th>
                <th className="p-4">Phone</th>
                <th className="p-4">Source</th>
                <th className="p-4">Status</th>
                <th className="p-4">Message</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-b border-[var(--line)] align-top">
                  <td className="p-4 text-sm text-[var(--muted)]">{formatDate(lead.created_at)}</td>
                  <td className="p-4">{lead.name || "-"}</td>
                  <td className="p-4 font-semibold">{lead.phone}</td>
                  <td className="p-4">
                    <span className="rounded-full bg-[#eee9df] px-3 py-1 text-sm font-semibold">
                      {lead.source.replace("_", " ")}
                    </span>
                  </td>
                  <td className="p-4">
                    <span className="rounded-full bg-[#e4f0e8] px-3 py-1 text-sm font-semibold text-[var(--good)]">
                      {lead.status}
                    </span>
                  </td>
                  <td className="max-w-sm p-4 text-[var(--muted)]">{lead.message || "-"}</td>
                </tr>
              ))}
              {leads.length === 0 ? (
                <tr>
                  <td className="p-6 text-[var(--muted)]" colSpan={6}>
                    No leads yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

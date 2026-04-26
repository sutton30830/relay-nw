import { cookies } from "next/headers";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { LeadsList } from "@/app/leads/leads-list";
import { publicBusinessName } from "@/lib/display-name";
import { env } from "@/lib/env";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";
import { getLeads, getRecentWebhookEvents } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const cookieStore = await cookies();
  const isAllowed = isValidLeadsSessionCookie(cookieStore.get(LEADS_COOKIE_NAME)?.value);
  const businessName = publicBusinessName(env.businessName);

  if (!isAllowed) {
    return (
      <main className="gate-view">
        <section className="gate-card">
          <div className="brand-mark" style={{ margin: "0 auto" }}>
            <Icon name="relay" size={18} />
          </div>
          <p className="t-eyebrow" style={{ marginTop: 14 }}>Relay NW · Protected</p>
          <h1 className="t-display gate-title">Lead inbox</h1>
          <p className="gate-sub">
            Enter the shared password to open <strong>{businessName}&apos;s</strong> leads.
          </p>

          <form action="/api/leads-login" method="POST" className="gate-form">
            <label className="field-label">
              <span>Password</span>
              <div className="gate-input">
                <Icon name="shield" size={14} />
                <input
                  className="field"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  placeholder="••••••••"
                />
              </div>
            </label>
            <button className="btn btn-primary" type="submit" style={{ width: "100%", marginTop: 12 }}>
              Open leads <Icon name="arrowRight" size={14} />
            </button>
          </form>

          <p className="gate-foot">
            Only the owner has this password.{" "}
            <Link href="/" style={{ textDecoration: "underline" }}>Back to setup</Link>
          </p>
        </section>
      </main>
    );
  }

  const [leads, webhookEvents] = await Promise.all([
    getLeads(),
    getRecentWebhookEvents(),
  ]);

  return (
    <main className="leads-view">
      <LeadsList businessName={businessName} leads={leads} webhookEvents={webhookEvents} />
    </main>
  );
}

import Link from "next/link";

export function OpsToolbar({
  showSetupRequests,
  subtitle,
  accountSlug,
  view = "overview",
}: {
  showSetupRequests: boolean;
  subtitle: string;
  accountSlug?: string;
  view?: "overview" | "logs";
}) {
  const accountQuery = accountSlug ? `?account=${encodeURIComponent(accountSlug)}` : "";
  const overviewHref = accountSlug ? `/ops?account=${encodeURIComponent(accountSlug)}` : "/ops";
  const logsHref = accountSlug ? `/ops?account=${encodeURIComponent(accountSlug)}&view=logs` : "/ops";

  return (
    <div className="ops-toolbar">
      <div>
        <p className="t-eyebrow">Ops tools</p>
        <span>{subtitle}</span>
      </div>
      <div className="ops-toolbar__actions">
        {accountSlug ? (
          <Link className={`btn btn-sm ${view === "overview" ? "btn-primary" : "btn-secondary"}`} href={overviewHref}>
            Account overview
          </Link>
        ) : null}
        <Link className="btn btn-secondary btn-sm" href={`/ops/billing${accountQuery}`}>{"Billing & setup"}</Link>
        {showSetupRequests ? (
          <Link className="btn btn-secondary btn-sm" href="/ops/setup-requests">Setup requests</Link>
        ) : null}
        <Link className="btn btn-secondary btn-sm" href="/ops/runbook">Runbook</Link>
        {accountSlug ? <Link className={`btn btn-sm ${view === "logs" ? "btn-primary" : "btn-secondary"}`} href={logsHref}>Troubleshoot</Link> : null}
        <Link className="btn btn-secondary btn-sm" href="/leads">Back to leads</Link>
      </div>
    </div>
  );
}

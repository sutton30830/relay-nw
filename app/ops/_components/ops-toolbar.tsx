import Link from "next/link";

export function OpsToolbar({
  showSetupRequests,
  subtitle,
}: {
  showSetupRequests: boolean;
  subtitle: string;
}) {
  return (
    <div className="ops-toolbar">
      <div>
        <p className="t-eyebrow">Ops tools</p>
        <span>{subtitle}</span>
      </div>
      <div className="ops-toolbar__actions">
        <Link className="btn btn-secondary btn-sm" href="/ops">Technical logs</Link>
        {showSetupRequests ? (
          <Link className="btn btn-secondary btn-sm" href="/ops/setup-requests">Setup requests</Link>
        ) : null}
        <Link className="btn btn-secondary btn-sm" href="/ops/runbook">Runbook</Link>
        <form action="/api/email-test/start" method="post">
          <button className="btn btn-secondary btn-sm" type="submit">Test owner email</button>
        </form>
        <Link className="btn btn-secondary btn-sm" href="/leads">Back to leads</Link>
      </div>
    </div>
  );
}

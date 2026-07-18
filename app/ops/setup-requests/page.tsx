import { OpsHeader } from "@/app/ops/_components/ops-header";
import { OpsToolbar } from "@/app/ops/_components/ops-toolbar";
import { requireRelayOperator } from "@/lib/auth";
import { listSetupRequests, type SetupRequest, type SetupRequestStatus } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const STATUS_OPTIONS: Array<{ value: SetupRequestStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "onboarded", label: "Onboarded" },
  { value: "closed", label: "Closed" },
];

const UPDATE_STATUSES: Array<{ value: SetupRequestStatus; label: string }> = STATUS_OPTIONS.filter(
  (option): option is { value: SetupRequestStatus; label: string } => option.value !== "all",
);

function validStatus(value: string | undefined): SetupRequestStatus | "all" {
  return STATUS_OPTIONS.some((option) => option.value === value) ? (value as SetupRequestStatus | "all") : "all";
}

function setupRequestFields(message: string | null) {
  if (!message) return [];

  return message
    .split("\n")
    .slice(1)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) return null;

      const label = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();

      return label && value ? { label, value } : null;
    })
    .filter((field): field is { label: string; value: string } => Boolean(field));
}

function statusClass(status: SetupRequestStatus) {
  if (status === "new") return "chip";
  if (status === "contacted") return "chip chip-muted";
  if (status === "onboarded") return "chip status-pill--booked";
  return "chip chip-danger";
}

function statusLabel(status: SetupRequestStatus) {
  return UPDATE_STATUSES.find((option) => option.value === status)?.label ?? status;
}

function SetupRequestCard({ request }: { request: SetupRequest }) {
  const fields = setupRequestFields(request.message);

  return (
    <article className="webhook-event">
      <div className="webhook-event__head">
        <div>
          <strong>{request.name ?? "Unknown setup request"}</strong>
          <p className="empty-copy">{request.phone}</p>
        </div>
        <span>{new Date(request.created_at).toLocaleString()}</span>
      </div>

      <div className="lead-actions" style={{ justifyContent: "space-between", marginTop: "var(--space-3)" }}>
        <span className={statusClass(request.status)}>{statusLabel(request.status)}</span>
        <form action="/api/ops/setup-requests" method="post" className="lead-controls" style={{ margin: 0 }}>
          <input type="hidden" name="id" value={request.id} />
          <select className="field" name="status" defaultValue={request.status} aria-label="Setup request status">
            {UPDATE_STATUSES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button className="btn btn-secondary btn-sm" type="submit">Update</button>
        </form>
      </div>

      {fields.length > 0 ? (
        <dl className="webhook-event__meta" style={{ marginTop: "var(--space-3)" }}>
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : request.message ? (
        <pre>{request.message}</pre>
      ) : null}
    </article>
  );
}

export default async function SetupRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requireRelayOperator();
  const { account } = session;

  const { status: rawStatus } = await searchParams;
  const status = validStatus(rawStatus);
  const requests = await listSetupRequests(status);

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <OpsHeader
          businessName={account.businessName}
          operatorEmail={session.email}
          switchAccountHref={session.membershipCount > 1 ? "/account/select?next=/ops/setup-requests" : undefined}
        />

        <OpsToolbar showSetupRequests subtitle="Assisted onboarding" />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Ops</p>
            <h1 className="t-display">Setup requests</h1>
            <p className="leads-subtitle">Track prospects from intake through white-glove onboarding.</p>
          </div>
        </div>

        <form className="lead-controls" action="/ops/setup-requests">
          <select className="field" name="status" defaultValue={status} aria-label="Filter setup requests by status">
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit">Filter</button>
        </form>

        <div className="webhook-events">
          {requests.length === 0 ? (
            <p className="empty-copy">No setup requests match this status.</p>
          ) : (
            requests.map((request) => <SetupRequestCard key={request.id} request={request} />)
          )}
        </div>
      </section>
    </main>
  );
}

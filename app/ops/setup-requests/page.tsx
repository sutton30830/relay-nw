import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";
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

function SetupRequestCard({ request, canAccept }: { request: SetupRequest; canAccept: boolean }) {
  const fields = setupRequestFields(request.message);

  return (
    <article className="lead-card setup-request-card">
      <div className="webhook-event__head">
        <div>
          <strong>{request.name ?? "Unknown setup request"}</strong>
          <p className="empty-copy">{request.phone}</p>
        </div>
        <span>{new Date(request.created_at).toLocaleString()}</span>
      </div>

      <div className="lead-card__actions" style={{ justifyContent: "space-between", marginTop: "var(--space-3)" }}>
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

      {/* The login email is the one field setup cannot proceed without — always
          show it from the structured column, not just the parsed message. */}
      <dl className="webhook-event__meta" style={{ marginTop: "var(--space-3)" }}>
        <div>
          <dt>Owner login email</dt>
          <dd>{request.owner_email || "⚠ not provided — enter it below before accepting"}</dd>
        </div>
      </dl>
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

      {request.account_id ? (
        <div className="ops-billing-actions" style={{ marginTop: "var(--space-3)" }}>
          <form action="/api/ops/setup-requests" method="post">
            <input type="hidden" name="id" value={request.id} />
            <input type="hidden" name="action" value="resend_invite" />
            <input type="hidden" name="owner_email" value={request.owner_email ?? ""} />
            <button className="btn btn-secondary btn-sm" type="submit" disabled={!canAccept || !request.owner_email}>Resend account invite</button>
          </form>
        </div>
      ) : (
        <form action="/api/ops/setup-requests" method="post" className="setup-panel__action" style={{ marginTop: "var(--space-3)" }}>
          <input type="hidden" name="id" value={request.id} />
          <input type="hidden" name="action" value="accept" />
          <div className="lead-controls">
            <input className="field" name="business_name" defaultValue={request.business_name ?? ""} placeholder="Business name" required />
            <input className="field" name="owner_name" defaultValue={request.owner_name ?? ""} placeholder="Owner name" required />
            <input className="field" name="owner_email" type="email" defaultValue={request.owner_email ?? ""} placeholder="Owner login email" required />
            <input className="field" name="business_type" defaultValue={request.business_type ?? ""} placeholder="Business type" required />
            <input className="field" name="public_business_number" defaultValue={request.public_business_number ?? ""} placeholder="Public business number" required />
            <button className="btn btn-primary" type="submit" disabled={!canAccept}>Accept and invite</button>
          </div>
          <p className="setup-panel__note">Creates a separate customer account with the $150 fee due. No Relay number or monthly charge starts yet.</p>
        </form>
      )}
    </article>
  );
}

export default async function SetupRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; result?: string }>;
}) {
  const operator = await requirePlatformOperator();

  const { status: rawStatus, result } = await searchParams as { status?: string; result?: string };
  const status = validStatus(rawStatus);
  const requests = await listSetupRequests(status);

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <OpsHeader currentPage="requests" operatorEmail={operator.email} />

        

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Requests</p>
            <h1 className="t-display">New customers start here.</h1>
            <p className="leads-subtitle">Review the request, then move it into kickoff with one clear next step.</p>
          </div>
        </div>

        {result ? <div className={result.includes("failed") || result === "invalid" || result === "email_required" ? "intake-error settings-notice" : "settings-notice"} role="status">
          {result === "invite_sent" ? "Customer invitation sent." : result === "created_invite_failed" ? "Account created, but the invitation email failed. Use Resend account invite." : result === "email_required" ? "A valid owner login email is required." : result === "already_onboarded" ? "That request already has a customer account." : result === "accept_failed" ? "The account could not be created. No payment was started." : "Request update completed."}
        </div> : null}

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
            requests.map((request) => <SetupRequestCard key={request.id} request={request} canAccept={operator.role !== "support"} />)
          )}
        </div>
      </section>
    </main>
  );
}

import Link from "next/link";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import { loadOperationsMonitoring, recordPlatformAuditEvent } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function formatDateTime(value: string | null) {
  if (!value) return "No signal yet";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatPercent(value: number | null) {
  return value === null ? "No attempts" : `${Math.round(value * 100)}%`;
}

function formatCronSignal(value: string | null, ok: boolean | null) {
  if (!value) return "No check-in yet";
  const state = ok === true ? "Succeeded" : ok === false ? "Failed" : "Status unknown";
  return `${state} · ${formatDateTime(value)}`;
}

export default async function OperationsMonitoringPage() {
  const operator = await requirePlatformOperator();
  const dashboard = await loadOperationsMonitoring();
  // Monitoring aggregates sensitive support diagnostics across every account.
  // Do not render it when the access event cannot be durably recorded.
  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    action: OPS_ACTIONS.diagnosticsRead,
    summary: "Viewed cross-account Operations monitoring",
  }, { required: true });
  const criticalCount = dashboard.rows.filter((row) => row.health.status === "critical").length;
  const warningCount = dashboard.rows.filter((row) => row.health.status === "warning").length;

  return (
    <main className="leads-view">
      <section className="leads-shell ops-monitoring">
        <OpsHeader currentPage="monitoring" operatorEmail={operator.email} />

        <div className="leads-header ops-monitoring__head">
          <div>
            <p className="t-eyebrow">Monitoring</p>
            <h1 className="t-display">Is Relay working for every business?</h1>
            <p className="leads-subtitle">
              Operator-only evidence from calls, messages, provider callbacks, billing, and scheduled jobs.
            </p>
          </div>
          <div className="ops-monitoring__summary" aria-label="Monitoring summary">
            <span className={criticalCount ? "chip chip-danger" : "chip"}>{criticalCount} critical</span>
            <span className={warningCount ? "chip chip-warn" : "chip"}>{warningCount} warning</span>
          </div>
        </div>

        {dashboard.unresolvedInvalidSignatures || dashboard.unresolvedWebhookErrors ? (
          <section className="panel ops-monitoring__platform-alert" aria-label="Unresolved platform events">
            <strong>Unresolved webhook traffic needs review</strong>
            <p>
              {dashboard.unresolvedInvalidSignatures} invalid signature{dashboard.unresolvedInvalidSignatures === 1 ? "" : "s"} and {dashboard.unresolvedWebhookErrors} processing error{dashboard.unresolvedWebhookErrors === 1 ? "" : "s"} could not be safely assigned to a business. No tenant was guessed.
            </p>
          </section>
        ) : null}

        <div className="ops-monitoring__thresholds" aria-label="Monitoring thresholds">
          <span>{dashboard.thresholds.activityWindowHours}h activity window</span>
          <span>SMS warning ≥ {Math.round(dashboard.thresholds.smsFailureRateWarning * 100)}% after {dashboard.thresholds.smsFailureMinimumAttempts} attempts</span>
          <span>Pipeline grace {dashboard.thresholds.missingLeadGraceMinutes}m</span>
          <span>Daily cron stale after {dashboard.thresholds.dailyCronStaleHours}h</span>
        </div>

        <div className="ops-monitoring__accounts">
          {dashboard.rows.length === 0 ? (
            <section className="panel ops-monitoring__empty">No businesses are available to monitor.</section>
          ) : dashboard.rows.map((row) => (
            <article className={`panel ops-monitor-card ops-monitor-card--${row.health.status}`} key={row.accountId}>
              <header className="ops-monitor-card__head">
                <div>
                  <p className="t-eyebrow">{row.accountStatus}</p>
                  <h2>{row.businessName}</h2>
                </div>
                <span className={`ops-monitor-card__status ops-monitor-card__status--${row.health.status}`}>
                  {row.health.status === "healthy" ? "Healthy" : `${row.health.alerts.length} issue${row.health.alerts.length === 1 ? "" : "s"}`}
                </span>
              </header>

              <div className="ops-monitor-card__signals">
                <section>
                  <h3>Calls</h3>
                  <dl>
                    <div><dt>Last captured call</dt><dd>{formatDateTime(row.lastSuccessfulCallAt)}</dd></div>
                    <div><dt>Forwarding</dt><dd>{row.forwardingVerifiedAt ? `Verified ${formatDateTime(row.forwardingVerifiedAt)}` : "Not verified"}</dd></div>
                  </dl>
                </section>
                <section>
                  <h3>Texting</h3>
                  <dl>
                    <div><dt>Last outbound success</dt><dd>{formatDateTime(row.lastSuccessfulOutboundSmsAt)}</dd></div>
                    <div><dt>Recent failure rate</dt><dd>{formatPercent(row.health.smsFailureRate)} ({row.smsFailures}/{row.smsAttempts})</dd></div>
                    <div><dt>A2P</dt><dd>{row.a2pStatus.replaceAll("_", " ")}</dd></div>
                  </dl>
                </section>
                <section>
                  <h3>Account</h3>
                  <dl>
                    <div><dt>Blocker</dt><dd>{row.blockerOwner === "none" ? "None" : `${row.blockerOwner}: ${row.blockerNote ?? "Reason missing"}`}</dd></div>
                    <div><dt>Billing</dt><dd>{row.billingState}</dd></div>
                    <div><dt>Last webhook</dt><dd>{formatDateTime(row.lastWebhookAt)}</dd></div>
                  </dl>
                </section>
                <section>
                  <h3>Scheduled checks</h3>
                  <dl>
                    <div><dt>Operations monitoring</dt><dd>{formatCronSignal(row.operationsMonitoringCronAt, row.operationsMonitoringCronOk)}</dd></div>
                    <div><dt>Transcription retry</dt><dd>{formatCronSignal(row.transcriptionCronAt, row.transcriptionCronOk)}</dd></div>
                    <div><dt>Billing reconciliation</dt><dd>{formatCronSignal(row.billingReconciliationAt, row.billingReconciliationCronOk)}</dd></div>
                    <div><dt>Retention</dt><dd>{formatCronSignal(row.retentionCronAt, row.retentionCronOk)}</dd></div>
                    <div><dt>Weekly digest</dt><dd>{formatCronSignal(row.weeklyDigestCronAt, row.weeklyDigestCronOk)}</dd></div>
                  </dl>
                </section>
              </div>

              {row.health.alerts.length > 0 ? (
                <div className="ops-monitor-card__alerts">
                  {row.health.alerts.map((alert) => (
                    <div className={`ops-monitor-alert ops-monitor-alert--${alert.severity}`} key={alert.fingerprint}>
                      <div><strong>{alert.title}</strong><span>Owner: {alert.owner}</span></div>
                      <p>{alert.detail}</p>
                      <small>{alert.recommendedAction}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="ops-monitor-card__clear">No actionable monitoring signals in the current window.</p>
              )}

              <footer>
                <Link className="btn btn-secondary btn-sm" href={`/ops/accounts/${encodeURIComponent(row.accountSlug)}#diagnostics`}>
                  Open diagnostics
                </Link>
              </footer>
            </article>
          ))}
        </div>

        <p className="ops-monitoring__generated">Calculated {formatDateTime(dashboard.generatedAt)}. Expected transcription-quality suppressions are excluded.</p>
      </section>
    </main>
  );
}

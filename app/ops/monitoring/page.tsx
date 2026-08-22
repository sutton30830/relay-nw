import Link from "next/link";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";
import { canPerformOpsAction, OPS_ACTIONS } from "@/lib/ops-actions";
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

type MonitoringSearchParams = {
  account?: string;
  voicemail_recovery?: string;
  attempted?: string;
  recovered?: string;
  skipped?: string;
  failed?: string;
};

function safeCount(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function recoveryNotice(
  params: MonitoringSearchParams,
  businessName: string,
) {
  const recovered = safeCount(params.recovered);
  const skipped = safeCount(params.skipped);
  const failed = safeCount(params.failed);

  switch (params.voicemail_recovery) {
    case "recovered":
      return {
        tone: "success" as const,
        message: `${businessName}: recovery finished. ${recovered} recovered${skipped ? `; ${skipped} already processing` : ""}.`,
      };
    case "no_work":
      return {
        tone: "success" as const,
        message: `${businessName}: nothing needs a safe retry right now. Monitoring is up to date.`,
      };
    case "partial":
      return {
        tone: "error" as const,
        message: `${businessName}: ${recovered} recovered, ${skipped} already processing, and ${failed} still need review.`,
      };
    case "failed":
      return {
        tone: "error" as const,
        message: `${businessName}: recovery could not finish. No customer notification was sent; review the remaining issue below.`,
      };
    case "inactive":
      return {
        tone: "error" as const,
        message: `${businessName}: recovery is unavailable while this account is paused or archived.`,
      };
    case "account_not_found":
      return {
        tone: "error" as const,
        message: "That account is no longer available.",
      };
    default:
      return null;
  }
}

function issueTitle(stage: "recording" | "transcription" | "summary", state: string) {
  if (stage === "recording") return "Recording needs review";
  if (stage === "summary") return "Summary needs recovery";
  if (state === "waiting") return "Transcript is waiting";
  if (state === "stalled") return "Transcription stalled";
  return "Transcription failed";
}

export default async function OperationsMonitoringPage({
  searchParams,
}: {
  searchParams: Promise<MonitoringSearchParams>;
}) {
  const operator = await requirePlatformOperator();
  const [dashboard, notices] = await Promise.all([
    loadOperationsMonitoring(),
    searchParams,
  ]);
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
  const noticeAccount = dashboard.rows.find((row) => row.accountSlug === notices.account);
  const notice = notices.voicemail_recovery
    ? recoveryNotice(notices, noticeAccount?.businessName ?? notices.account ?? "Account")
    : null;
  const canRunRecovery = canPerformOpsAction(operator.role, OPS_ACTIONS.voicemailRecovery);

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

        {notice ? (
          <div
            className={notice.tone === "error" ? "intake-error settings-notice" : "settings-notice"}
            aria-live="polite"
          >
            {notice.message}
          </div>
        ) : null}

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
          ) : dashboard.rows.map((row) => {
            const automaticIssues = row.voicemailPipeline.issues.filter(
              (issue) => issue.retryEligibility === "automatic",
            );
            const reviewIssues = row.voicemailPipeline.issues.filter(
              (issue) => issue.retryEligibility !== "automatic",
            );
            const voicemailState = reviewIssues.length > 0
              ? "needs_you"
              : automaticIssues.length > 0
                ? "recovery_scheduled"
                : row.voicemailPipeline.processing > 0
                  ? "working"
                  : "healthy";
            const voicemailStateLabel = voicemailState === "needs_you"
              ? "Needs you"
              : voicemailState === "recovery_scheduled"
                ? "Recovery scheduled"
                : voicemailState === "working"
                  ? "Relay is working"
                  : "Healthy";
            const voicemailStateCopy = voicemailState === "needs_you"
              ? `${reviewIssues.length} voicemail ${reviewIssues.length === 1 ? "needs" : "need"} review.${automaticIssues.length > 0 ? " Safe automatic recovery remains available for the other eligible items." : " Review its evidence before retrying."}`
              : voicemailState === "recovery_scheduled"
                ? `${automaticIssues.length} voicemail ${automaticIssues.length === 1 ? "is" : "are"} eligible for Relay's safe recovery.`
                : voicemailState === "working"
                  ? `Relay is currently processing ${row.voicemailPipeline.processing} voicemail${row.voicemailPipeline.processing === 1 ? "" : "s"}. No action is needed.`
                  : "No voicemail requires operator action.";

            return (
              <article
                className={`panel ops-monitor-card ops-monitor-card--${row.health.status}`}
                id={`account-${row.accountSlug}`}
                key={row.accountId}
              >
              <header className="ops-monitor-card__head">
                <div>
                  <p className="t-eyebrow">{row.accountStatus}</p>
                  <h2>{row.businessName}</h2>
                </div>
                <span className={`ops-monitor-card__status ops-monitor-card__status--${row.health.status}`}>
                  {row.health.status === "healthy" ? "Account checks clear" : `${row.health.alerts.length} system alert${row.health.alerts.length === 1 ? "" : "s"}`}
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

              <section className={`ops-voicemail-pipeline ops-voicemail-pipeline--${voicemailState}`} aria-label={`${row.businessName} voicemail health`}>
                <div className="ops-voicemail-pipeline__head">
                  <div>
                    <p className="t-eyebrow">Voicemail health</p>
                    <h3>{voicemailStateLabel}</h3>
                    <p>{voicemailStateCopy}</p>
                  </div>
                  <span className={voicemailState === "needs_you" ? "chip chip-danger" : voicemailState === "recovery_scheduled" ? "chip chip-warn" : "chip"}>
                    {voicemailStateLabel}
                  </span>
                </div>
                {automaticIssues.length > 0 && canRunRecovery ? (
                  <form action="/api/ops/voicemail/recover" method="post" className="ops-voicemail-pipeline__action">
                    <input type="hidden" name="account_slug" value={row.accountSlug} />
                    <div>
                      <strong>Want to resolve it now?</strong>
                      <small>This retries only eligible voicemail work. It will not email or text the owner.</small>
                    </div>
                    <button className="btn btn-primary btn-sm" type="submit">Run safe recovery now</button>
                  </form>
                ) : null}
                {automaticIssues.length > 0 && !canRunRecovery ? (
                  <p className="ops-voicemail-pipeline__clear">An operator can run recovery now. Your support access is read-only.</p>
                ) : null}
                {row.voicemailPipeline.issues.length > 0 ? (
                  <div className="ops-voicemail-pipeline__issues">
                    {row.voicemailPipeline.issues.map((issue) => {
                      const evidenceHref = issue.providerActionId
                        ? `/ops/accounts/${encodeURIComponent(row.accountSlug)}?evidence=${encodeURIComponent(issue.providerActionId)}#provider-action-${encodeURIComponent(issue.providerActionId)}`
                        : `/ops/accounts/${encodeURIComponent(row.accountSlug)}?evidence=${encodeURIComponent(issue.leadId)}#diagnostics`;
                      return (
                        <article className={`ops-voicemail-issue ops-voicemail-issue--${issue.severity}`} key={`${issue.leadId}:${issue.stage}`}>
                          <div>
                            <strong>{issueTitle(issue.stage, issue.state)}</strong>
                            <span>{formatDateTime(issue.lastChangedAt)} · caller ••••{issue.callerLast4 ?? "unknown"}</span>
                          </div>
                          <p>{issue.detail}</p>
                          <small>
                            {issue.retryEligibility === "automatic"
                              ? "Relay can safely retry this automatically."
                              : issue.retryEligibility === "manual"
                                ? "Review the evidence before taking action."
                                : "Relay will not retry this automatically."}
                          </small>
                          <Link className="text-link" href={evidenceHref}>View technical evidence</Link>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="ops-voicemail-pipeline__clear">Nothing needs recovery or review.</p>
                )}
                {row.voicemailPipeline.suppressed > 0 ? (
                  <p className="ops-voicemail-pipeline__suppressed">
                    No action needed: {row.voicemailPipeline.suppressed} recording{row.voicemailPipeline.suppressed === 1 ? " was" : "s were"} too short, silent, or unreliable to summarize safely.
                  </p>
                ) : null}
                <details className="ops-voicemail-pipeline__technical">
                  <summary>Technical details</summary>
                  <div className="ops-voicemail-pipeline__technical-body">
                    <dl className="ops-voicemail-pipeline__counts">
                      <div><dt>Recordings</dt><dd>{row.voicemailPipeline.recordings}</dd></div>
                      <div><dt>Transcripts ready</dt><dd>{row.voicemailPipeline.transcriptsReady}</dd></div>
                      <div><dt>Summaries ready</dt><dd>{row.voicemailPipeline.summariesReady}</dd></div>
                      <div><dt>Processing</dt><dd>{row.voicemailPipeline.processing}</dd></div>
                      <div><dt>Waiting</dt><dd>{row.voicemailPipeline.waiting}</dd></div>
                      <div><dt>Stalled</dt><dd>{row.voicemailPipeline.stalled}</dd></div>
                      <div><dt>Failed</dt><dd>{row.voicemailPipeline.failed}</dd></div>
                      <div><dt>Quality-suppressed</dt><dd>{row.voicemailPipeline.suppressed}</dd></div>
                    </dl>
                    <p className="ops-voicemail-pipeline__retry">
                      <strong>Last scheduled recovery:</strong> {formatCronSignal(row.transcriptionCronAt, row.transcriptionCronOk)}
                      {row.transcriptionCronDetail ? ` · ${row.transcriptionCronDetail}` : ""}
                    </p>
                  </div>
                </details>
              </section>

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
            );
          })}
        </div>

        <p className="ops-monitoring__generated">Calculated {formatDateTime(dashboard.generatedAt)}. Expected transcription-quality suppressions are excluded.</p>
      </section>
    </main>
  );
}

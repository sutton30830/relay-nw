export const DEFAULT_MONITORING_THRESHOLDS = {
  activityWindowHours: 24,
  missingLeadGraceMinutes: 5,
  missingAutomaticTextGraceMinutes: 5,
  smsFailureRateWarning: 0.2,
  smsFailureMinimumAttempts: 3,
  operationsMonitoringCronStaleMinutes: 15,
  dailyCronStaleHours: 36,
  weeklyCronStaleHours: 192,
} as const;

export type MonitoringThresholds = {
  activityWindowHours: number;
  missingLeadGraceMinutes: number;
  missingAutomaticTextGraceMinutes: number;
  smsFailureRateWarning: number;
  smsFailureMinimumAttempts: number;
  operationsMonitoringCronStaleMinutes: number;
  dailyCronStaleHours: number;
  weeklyCronStaleHours: number;
};

export type MonitoringAlertCode =
  | "pre_send_check_failed"
  | "call_without_lead"
  | "missed_call_without_text_attempt"
  | "terminal_sms_failure"
  | "elevated_sms_failure_rate"
  | "invalid_webhook_signature"
  | "webhook_processing_error"
  | "duplicate_event_conflict"
  | "recording_or_transcription_failure"
  | "billing_reconciliation_failure"
  | "operations_monitoring_cron_stale"
  | "transcription_cron_stale"
  | "billing_reconciliation_stale"
  | "retention_cron_stale"
  | "weekly_digest_cron_stale"
  | "phone_number_configuration";

export type MonitoringAlert = {
  accountId: string;
  code: MonitoringAlertCode;
  severity: "warning" | "critical";
  title: string;
  detail: string;
  owner: "relay" | "carrier" | "stripe";
  recommendedAction: string;
  fingerprint: string;
};

export type AccountMonitoringInput = {
  accountId: string;
  callsWithoutLeads: number;
  missedCallsWithoutTextAttempt: number;
  preSendCheckFailures?: number;
  smsAttempts: number;
  smsFailures: number;
  invalidWebhookSignatures: number;
  webhookProcessingErrors: number;
  duplicateEventConflicts: number;
  recordingOrTranscriptionFailures: number;
  billingReconciliationFailures: number;
  phoneNumberCount: number;
  primaryPhoneNumberCount: number;
  duplicatePhoneNumberCount: number;
  operationsMonitoringCronAt: string | null;
  operationsMonitoringCronOk: boolean | null;
  transcriptionCronAt: string | null;
  transcriptionCronOk: boolean | null;
  billingReconciliationAt: string | null;
  billingReconciliationCronOk: boolean | null;
  retentionCronAt: string | null;
  retentionCronOk: boolean | null;
  weeklyDigestCronAt: string | null;
  weeklyDigestCronOk: boolean | null;
  billingReconciliationExpected: boolean;
};

export type AccountHealth = {
  status: "healthy" | "warning" | "critical";
  smsFailureRate: number | null;
  alerts: MonitoringAlert[];
};

function ageHours(value: string | null, now: Date) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now.getTime() - timestamp) / 3_600_000);
}

function ageMinutes(value: string | null, now: Date) {
  const hours = ageHours(value, now);
  return hours === null ? null : hours * 60;
}

function alert(
  input: Omit<MonitoringAlert, "fingerprint">,
): MonitoringAlert {
  return { ...input, fingerprint: `${input.accountId}:${input.code}` };
}

export function deduplicateMonitoringAlerts(alerts: MonitoringAlert[]) {
  const severityRank = { warning: 1, critical: 2 } as const;
  const byFingerprint = new Map<string, MonitoringAlert>();

  for (const candidate of alerts) {
    const existing = byFingerprint.get(candidate.fingerprint);
    if (!existing || severityRank[candidate.severity] > severityRank[existing.severity]) {
      byFingerprint.set(candidate.fingerprint, candidate);
    }
  }

  return [...byFingerprint.values()];
}

export function monitoringAlertBucketKey(
  alertInput: Pick<MonitoringAlert, "accountId" | "code">,
  now: Date,
  bucketHours = 24,
) {
  const bucketMs = Math.max(1, bucketHours) * 3_600_000;
  const bucket = Math.floor(now.getTime() / bucketMs);
  return `monitoring_alert:${alertInput.accountId}:${alertInput.code}:${bucket}`;
}

export function calculateAccountHealth(
  input: AccountMonitoringInput,
  thresholds: MonitoringThresholds = DEFAULT_MONITORING_THRESHOLDS,
  now = new Date(),
): AccountHealth {
  const alerts: MonitoringAlert[] = [];
  const smsFailureRate = input.smsAttempts > 0
    ? input.smsFailures / input.smsAttempts
    : null;

  if (input.callsWithoutLeads > 0) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "call_without_lead",
      severity: "critical",
      title: "Missed call did not create a lead",
      detail: `${input.callsWithoutLeads} missed call${input.callsWithoutLeads === 1 ? "" : "s"} exceeded the ${thresholds.missingLeadGraceMinutes}-minute grace period without a lead.`,
      owner: "relay",
      recommendedAction: "Inspect the call and dial-status webhook, then recover the lead before contacting the customer.",
    }));
  }

  if (input.missedCallsWithoutTextAttempt > 0) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "missed_call_without_text_attempt",
      severity: "critical",
      title: "Automatic text was not attempted",
      detail: `${input.missedCallsWithoutTextAttempt} eligible missed call${input.missedCallsWithoutTextAttempt === 1 ? "" : "s"} remained pending beyond ${thresholds.missingAutomaticTextGraceMinutes} minutes.`,
      owner: "relay",
      recommendedAction: "Check the lead, opt-out, A2P, and provider-action evidence before any manual send.",
    }));
  }

  if ((input.preSendCheckFailures ?? 0) > 0) {
    alerts.push(alert({
      accountId: input.accountId, code: "pre_send_check_failed", severity: "critical",
      title: "Texting checks unavailable",
      detail: `${input.preSendCheckFailures} missed-call texting checks could not complete. Caller texts were withheld.`,
      owner: "relay", recommendedAction: "Check contact/opt-out storage and the action evidence. Follow up manually; do not replay automatic texts.",
    }));
  }

  if (input.smsFailures > 0) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "terminal_sms_failure",
      severity: "critical",
      title: "Customer text reached a terminal failure",
      detail: `${input.smsFailures} recent outbound text${input.smsFailures === 1 ? " has" : "s have"} a failed or undelivered provider status.`,
      owner: "carrier",
      recommendedAction: "Review the signed delivery status and carrier code; do not automatically resend or retry a permanent failure.",
    }));
  }

  if (
    smsFailureRate !== null &&
    input.smsAttempts >= thresholds.smsFailureMinimumAttempts &&
    smsFailureRate >= thresholds.smsFailureRateWarning
  ) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "elevated_sms_failure_rate",
      severity: smsFailureRate >= 0.5 ? "critical" : "warning",
      title: "SMS failure rate is elevated",
      detail: `${input.smsFailures} of ${input.smsAttempts} recent outbound texts failed (${Math.round(smsFailureRate * 100)}%).`,
      owner: "carrier",
      recommendedAction: "Review Twilio error codes and A2P state; do not retry permanent or landline failures.",
    }));
  }

  if (input.invalidWebhookSignatures > 0) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "invalid_webhook_signature",
      severity: "warning",
      title: "Invalid webhook signature rejected",
      detail: `${input.invalidWebhookSignatures} invalid Twilio webhook signature${input.invalidWebhookSignatures === 1 ? " was" : "s were"} rejected in the monitoring window.`,
      owner: "relay",
      recommendedAction: "Confirm the configured public callback URL and Twilio auth token; investigate repeated unknown traffic.",
    }));
  }

  if (input.webhookProcessingErrors > 0) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "webhook_processing_error",
      severity: "critical",
      title: "Webhook processing failed",
      detail: `${input.webhookProcessingErrors} provider callback${input.webhookProcessingErrors === 1 ? "" : "s"} failed processing.`,
      owner: "relay",
      recommendedAction: "Scope by correlation ID and replay only the same idempotent provider event after fixing the cause.",
    }));
  }

  if (input.duplicateEventConflicts > 0) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "duplicate_event_conflict",
      severity: "critical",
      title: "Duplicate event contains conflicting evidence",
      detail: `${input.duplicateEventConflicts} duplicate or ambiguous provider event${input.duplicateEventConflicts === 1 ? " has" : "s have"} conflicting tenant or resource evidence.`,
      owner: "relay",
      recommendedAction: "Do not guess the tenant. Compare provider IDs and metadata, then reconcile the authoritative record.",
    }));
  }

  if (input.recordingOrTranscriptionFailures > 0) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "recording_or_transcription_failure",
      severity: "warning",
      title: "Voicemail pipeline needs recovery",
      detail: `${input.recordingOrTranscriptionFailures} queued, stalled, or failed voicemail item${input.recordingOrTranscriptionFailures === 1 ? "" : "s"} need attention; expected quality suppressions are excluded.`,
      owner: "relay",
      recommendedAction: "Open the affected-call evidence, confirm its exact stage, then use only the listed retry path.",
    }));
  }

  if (input.billingReconciliationFailures > 0) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "billing_reconciliation_failure",
      severity: "critical",
      title: "Billing reconciliation failed",
      detail: `${input.billingReconciliationFailures} current Stripe reconciliation failure${input.billingReconciliationFailures === 1 ? "" : "s"} remain.`,
      owner: "stripe",
      recommendedAction: "Reconcile from Stripe; never create a second charge or subscription to repair local state.",
    }));
  }

  // A missing per-account check-in is a bootstrap state, not proof that the
  // scheduler is stale. Sentry's external cron monitors own "never invoked"
  // detection; after the first check-in, these account-scoped ages detect
  // stalled or failed work without manufacturing alerts for new accounts.
  const operationsMonitoringAge = ageMinutes(input.operationsMonitoringCronAt, now);
  if (
    input.operationsMonitoringCronOk === false ||
    (operationsMonitoringAge !== null &&
      operationsMonitoringAge > thresholds.operationsMonitoringCronStaleMinutes)
  ) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "operations_monitoring_cron_stale",
      severity: "critical",
      title: input.operationsMonitoringCronOk === false
        ? "Operations monitoring cron failed"
        : "Operations monitoring cron is stale",
      detail: input.operationsMonitoringCronOk === false
        ? "The latest scheduled monitoring evaluation failed."
        : `Last check-in was ${Math.floor(operationsMonitoringAge!)} minutes ago.`,
      owner: "relay",
      recommendedAction: "Check the Vercel invocation and Sentry Cron Monitor before relying on the Operations dashboard.",
    }));
  }

  const transcriptionAge = ageHours(input.transcriptionCronAt, now);
  if (
    input.transcriptionCronOk === false ||
    (transcriptionAge !== null && transcriptionAge > thresholds.dailyCronStaleHours)
  ) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "transcription_cron_stale",
      severity: input.transcriptionCronOk === false ? "critical" : "warning",
      title: input.transcriptionCronOk === false
        ? "Transcription retry cron failed"
        : "Transcription retry cron is stale",
      detail: input.transcriptionCronOk === false
        ? "The latest transcription-retry check-in recorded a job failure."
        : `Last check-in was ${Math.floor(transcriptionAge!)} hours ago.`,
      owner: "relay",
      recommendedAction: "Check the Vercel cron invocation and CRON_SECRET, then run one authenticated recovery check.",
    }));
  }

  const digestAge = ageHours(input.weeklyDigestCronAt, now);
  if (
    input.weeklyDigestCronOk === false ||
    (digestAge !== null && digestAge > thresholds.weeklyCronStaleHours)
  ) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "weekly_digest_cron_stale",
      severity: input.weeklyDigestCronOk === false ? "critical" : "warning",
      title: input.weeklyDigestCronOk === false
        ? "Weekly digest cron failed"
        : "Weekly digest cron is stale",
      detail: input.weeklyDigestCronOk === false
        ? "The latest weekly-digest check-in recorded a job failure."
        : `Last check-in was ${Math.floor(digestAge!)} hours ago.`,
      owner: "relay",
      recommendedAction: "Check the Vercel cron invocation and email-provider result; no empty digest needs to be sent.",
    }));
  }

  const retentionAge = ageHours(input.retentionCronAt, now);
  if (
    input.retentionCronOk === false ||
    (retentionAge !== null && retentionAge > thresholds.dailyCronStaleHours)
  ) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "retention_cron_stale",
      severity: "critical",
      title: input.retentionCronOk === false
        ? "Retention cron failed"
        : "Retention cron is stale",
      detail: input.retentionCronOk === false
        ? "The latest retention check-in recorded a deletion or persistence failure."
        : `Last check-in was ${Math.floor(retentionAge!)} hours ago.`,
      owner: "relay",
      recommendedAction: "Inspect the retention report and provider evidence, then retry only the idempotent deletion work.",
    }));
  }

  if (input.billingReconciliationExpected) {
    const billingAge = ageHours(input.billingReconciliationAt, now);
    if (billingAge !== null && billingAge > thresholds.dailyCronStaleHours) {
      alerts.push(alert({
        accountId: input.accountId,
        code: "billing_reconciliation_stale",
        severity: "critical",
        title: "Billing reconciliation is stale",
        detail: `Last check-in was ${Math.floor(billingAge)} hours ago.`,
        owner: "stripe",
        recommendedAction: "Check the scheduled job, then reconcile the existing Stripe customer and subscription.",
      }));
    }
  }

  if (
    input.phoneNumberCount !== 1 ||
    input.primaryPhoneNumberCount !== 1 ||
    input.duplicatePhoneNumberCount > 0
  ) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "phone_number_configuration",
      severity: "critical",
      title: "Relay number configuration is ambiguous",
      detail: `Found ${input.phoneNumberCount} assigned number${input.phoneNumberCount === 1 ? "" : "s"}, ${input.primaryPhoneNumberCount} primary, and ${input.duplicatePhoneNumberCount} cross-account duplicate${input.duplicatePhoneNumberCount === 1 ? "" : "s"}.`,
      owner: "relay",
      recommendedAction: "Resolve the number mapping before changing Twilio callbacks or forwarding instructions.",
    }));
  }

  const deduped = deduplicateMonitoringAlerts(alerts);
  const status = deduped.some((item) => item.severity === "critical")
    ? "critical"
    : deduped.length > 0
      ? "warning"
      : "healthy";

  return { status, smsFailureRate, alerts: deduped };
}

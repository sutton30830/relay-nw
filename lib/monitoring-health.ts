export const DEFAULT_MONITORING_THRESHOLDS = {
  activityWindowHours: 24,
  missingLeadGraceMinutes: 5,
  missingAutomaticTextGraceMinutes: 5,
  smsFailureRateWarning: 0.2,
  smsFailureMinimumAttempts: 3,
  dailyCronStaleHours: 36,
  weeklyCronStaleHours: 192,
} as const;

export type MonitoringThresholds = {
  activityWindowHours: number;
  missingLeadGraceMinutes: number;
  missingAutomaticTextGraceMinutes: number;
  smsFailureRateWarning: number;
  smsFailureMinimumAttempts: number;
  dailyCronStaleHours: number;
  weeklyCronStaleHours: number;
};

export type MonitoringAlertCode =
  | "call_without_lead"
  | "missed_call_without_text_attempt"
  | "elevated_sms_failure_rate"
  | "invalid_webhook_signature"
  | "webhook_processing_error"
  | "duplicate_event_conflict"
  | "recording_or_transcription_failure"
  | "billing_reconciliation_failure"
  | "transcription_cron_stale"
  | "billing_reconciliation_stale"
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
  transcriptionCronAt: string | null;
  billingReconciliationAt: string | null;
  weeklyDigestCronAt: string | null;
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
      title: "Recording or transcription needs recovery",
      detail: `${input.recordingOrTranscriptionFailures} operational failure${input.recordingOrTranscriptionFailures === 1 ? "" : "s"} remain; expected quality suppressions are excluded.`,
      owner: "relay",
      recommendedAction: "Confirm recording retrieval, then use the idempotent transcription retry path when eligible.",
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

  const transcriptionAge = ageHours(input.transcriptionCronAt, now);
  if (transcriptionAge === null || transcriptionAge > thresholds.dailyCronStaleHours) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "transcription_cron_stale",
      severity: "warning",
      title: "Transcription retry cron is stale",
      detail: transcriptionAge === null ? "No transcription-retry check-in has been recorded." : `Last check-in was ${Math.floor(transcriptionAge)} hours ago.`,
      owner: "relay",
      recommendedAction: "Check the Vercel cron invocation and CRON_SECRET, then run one authenticated recovery check.",
    }));
  }

  const digestAge = ageHours(input.weeklyDigestCronAt, now);
  if (digestAge === null || digestAge > thresholds.weeklyCronStaleHours) {
    alerts.push(alert({
      accountId: input.accountId,
      code: "weekly_digest_cron_stale",
      severity: "warning",
      title: "Weekly digest cron is stale",
      detail: digestAge === null ? "No weekly-digest check-in has been recorded." : `Last check-in was ${Math.floor(digestAge)} hours ago.`,
      owner: "relay",
      recommendedAction: "Check the Vercel cron invocation and email-provider result; no empty digest needs to be sent.",
    }));
  }

  if (input.billingReconciliationExpected) {
    const billingAge = ageHours(input.billingReconciliationAt, now);
    if (billingAge === null || billingAge > thresholds.dailyCronStaleHours) {
      alerts.push(alert({
        accountId: input.accountId,
        code: "billing_reconciliation_stale",
        severity: "critical",
        title: "Billing reconciliation is stale",
        detail: billingAge === null ? "No scheduled billing-reconciliation check-in has been recorded." : `Last check-in was ${Math.floor(billingAge)} hours ago.`,
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

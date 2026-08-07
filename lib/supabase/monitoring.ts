import { env } from "@/lib/env";
import {
  calculateAccountHealth,
  type MonitoringThresholds,
} from "@/lib/monitoring-health";
import { deriveOpsState } from "@/lib/ops-state";
import { isPlaceholderSupabaseConfig, supabaseAdmin, throwIfSupabaseError } from "./client";
import { listOpsAccounts } from "./accounts";

type DataRow = Record<string, unknown>;

export type OperationsMonitoringRow = {
  accountId: string;
  accountSlug: string;
  businessName: string;
  accountStatus: "active" | "paused" | "archived";
  health: ReturnType<typeof calculateAccountHealth>;
  lastSuccessfulCallAt: string | null;
  lastSuccessfulOutboundSmsAt: string | null;
  forwardingVerifiedAt: string | null;
  a2pStatus: string;
  blockerOwner: string;
  blockerNote: string | null;
  billingState: string;
  lastWebhookAt: string | null;
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
  smsAttempts: number;
  smsFailures: number;
};

export type OperationsMonitoringDashboard = {
  generatedAt: string;
  thresholds: MonitoringThresholds;
  rows: OperationsMonitoringRow[];
  unresolvedInvalidSignatures: number;
  unresolvedWebhookErrors: number;
};

const MISSED_CALL_STATUSES = new Set(["missed", "no-answer", "busy", "failed", "canceled"]);
const SMS_ATTEMPT_STATUSES = new Set(["queued", "sending", "sent", "delivered", "failed", "undelivered"]);
const SMS_SUCCESS_STATUSES = new Set(["queued", "sending", "sent", "delivered"]);
const SMS_FAILURE_STATUSES = new Set(["failed", "undelivered"]);

function timestamp(row: DataRow, key: string) {
  return typeof row[key] === "string" ? row[key] as string : null;
}

function latest(rows: DataRow[], key: string) {
  let result: string | null = null;
  for (const row of rows) {
    const value = timestamp(row, key);
    if (value && (!result || value > result)) result = value;
  }
  return result;
}

function rowsForAccount(rows: DataRow[], accountId: string) {
  return rows.filter((row) => row.account_id === accountId);
}

function containsOperationalConflict(row: DataRow) {
  if (row.suppressed === true || row.internal_status === "suppressed") return false;
  const text = [row.provider_status, row.failure_code, row.diagnostic_detail]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return row.internal_status === "failed" && /conflict|ambiguous|mismatch|duplicate.+different/i.test(text);
}

function billingReconciliationExpected(account: Awaited<ReturnType<typeof listOpsAccounts>>[number]) {
  return Boolean(
    account.stripeSubscriptionStatus ||
    account.billingStatus === "active" ||
    account.billingStatus === "trialing" ||
    account.billingStatus === "past_due" ||
    account.setupFeeStatus === "paid" ||
    account.setupFeeStatus === "partially_refunded" ||
    account.setupFeeStatus === "disputed" ||
    account.setupFeeStatus === "charged_back"
  );
}

export function monitoringThresholdsFromEnv(): MonitoringThresholds {
  return {
    activityWindowHours: env.monitoringActivityWindowHours,
    missingLeadGraceMinutes: env.monitoringMissingLeadGraceMinutes,
    missingAutomaticTextGraceMinutes: env.monitoringMissingSmsGraceMinutes,
    smsFailureRateWarning: env.monitoringSmsFailureRatePercent / 100,
    smsFailureMinimumAttempts: env.monitoringSmsFailureMinimumAttempts,
    operationsMonitoringCronStaleMinutes: env.monitoringEvaluatorStaleMinutes,
    dailyCronStaleHours: env.monitoringDailyCronStaleHours,
    weeklyCronStaleHours: env.monitoringWeeklyCronStaleHours,
  };
}

export async function loadOperationsMonitoring(): Promise<OperationsMonitoringDashboard> {
  const thresholds = monitoringThresholdsFromEnv();
  const now = new Date();
  const generatedAt = now.toISOString();
  if (isPlaceholderSupabaseConfig()) {
    return { generatedAt, thresholds, rows: [], unresolvedInvalidSignatures: 0, unresolvedWebhookErrors: 0 };
  }

  // Paused and archived accounts intentionally stop receiving service and cron
  // work. Monitoring them as if they were active would manufacture noise about
  // detached numbers and missing check-ins.
  const accounts = (await listOpsAccounts()).filter((account) => account.accountStatus === "active");
  const accountIds = accounts.map((account) => account.accountId);
  if (accountIds.length === 0) {
    return { generatedAt, thresholds, rows: [], unresolvedInvalidSignatures: 0, unresolvedWebhookErrors: 0 };
  }

  const activitySince = new Date(now.getTime() - thresholds.activityWindowHours * 3_600_000).toISOString();
  const webhookSince = new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString();
  const providerSince = new Date(now.getTime() - 14 * 24 * 3_600_000).toISOString();

  const [callsResult, leadsResult, messagesResult, webhookResult, providerResult, phoneResult, auditResult, stripeResult, unresolvedWebhookResult] = await Promise.all([
    supabaseAdmin.from("calls").select("account_id, lead_id, status, dial_call_status, created_at").in("account_id", accountIds).gte("created_at", activitySince).limit(5000),
    supabaseAdmin.from("leads").select("account_id, id, source, sms_status, created_at").in("account_id", accountIds).eq("source", "missed_call").is("deleted_at", null).order("created_at", { ascending: false }).limit(5000),
    supabaseAdmin.from("messages").select("account_id, lead_id, direction, status, twilio_message_sid, created_at").in("account_id", accountIds).eq("direction", "outbound").order("created_at", { ascending: false }).limit(5000),
    supabaseAdmin.from("webhook_events").select("account_id, created_at, source, response_status, error").in("account_id", accountIds).gte("created_at", webhookSince).order("created_at", { ascending: false }).limit(5000),
    supabaseAdmin.from("provider_action_events").select("account_id, action, provider, resource_id, internal_status, provider_status, failure_code, diagnostic_detail, suppressed, last_attempt_at").in("account_id", accountIds).gte("last_attempt_at", providerSince).order("last_attempt_at", { ascending: false }).limit(5000),
    supabaseAdmin.from("account_phone_numbers").select("account_id, phone_number, is_primary").in("account_id", accountIds).limit(1000),
    supabaseAdmin.from("account_audit_events").select("account_id, action, created_at").in("account_id", accountIds).eq("action", "onboarding.first_call_live").order("created_at", { ascending: false }).limit(1000),
    supabaseAdmin.from("stripe_events").select("account_id, received_at").in("account_id", accountIds).order("received_at", { ascending: false }).limit(5000),
    supabaseAdmin.from("webhook_events").select("account_id, response_status, error, created_at").is("account_id", null).gte("created_at", activitySince).limit(1000),
  ]);

  for (const result of [callsResult, leadsResult, messagesResult, webhookResult, providerResult, phoneResult, auditResult, stripeResult, unresolvedWebhookResult]) {
    throwIfSupabaseError(result.error);
  }

  const calls = (callsResult.data ?? []) as DataRow[];
  const leads = (leadsResult.data ?? []) as DataRow[];
  const messages = (messagesResult.data ?? []) as DataRow[];
  const webhooks = (webhookResult.data ?? []) as DataRow[];
  const providerActions = (providerResult.data ?? []) as DataRow[];
  const phoneNumbers = (phoneResult.data ?? []) as DataRow[];
  const audits = (auditResult.data ?? []) as DataRow[];
  const stripeEvents = (stripeResult.data ?? []) as DataRow[];
  const unresolvedWebhooks = (unresolvedWebhookResult.data ?? []) as DataRow[];
  const leadGraceCutoff = new Date(now.getTime() - thresholds.missingLeadGraceMinutes * 60_000).toISOString();
  const smsGraceCutoff = new Date(now.getTime() - thresholds.missingAutomaticTextGraceMinutes * 60_000).toISOString();

  const phoneUseCounts = new Map<string, number>();
  for (const row of phoneNumbers) {
    const phone = typeof row.phone_number === "string" ? row.phone_number : null;
    if (phone) phoneUseCounts.set(phone, (phoneUseCounts.get(phone) ?? 0) + 1);
  }

  const rows = accounts.map((account): OperationsMonitoringRow => {
    const accountCalls = rowsForAccount(calls, account.accountId);
    const accountLeads = rowsForAccount(leads, account.accountId);
    const accountMessages = rowsForAccount(messages, account.accountId);
    const recentMessages = accountMessages.filter((row) => timestamp(row, "created_at")! >= activitySince);
    const accountWebhooks = rowsForAccount(webhooks, account.accountId);
    const recentWebhooks = accountWebhooks.filter((row) => timestamp(row, "created_at")! >= activitySince);
    const accountActions = rowsForAccount(providerActions, account.accountId);
    const recentActions = accountActions.filter((row) => timestamp(row, "last_attempt_at")! >= activitySince);
    const accountPhones = rowsForAccount(phoneNumbers, account.accountId);
    const accountAudits = rowsForAccount(audits, account.accountId);
    const accountStripeEvents = rowsForAccount(stripeEvents, account.accountId);
    const successfulMessages = accountMessages.filter((row) =>
      SMS_SUCCESS_STATUSES.has(String(row.status ?? "")) && typeof row.twilio_message_sid === "string"
    );
    const messageSmsAttempts = recentMessages.filter((row) => SMS_ATTEMPT_STATUSES.has(String(row.status ?? ""))).length;
    const messageSmsFailures = recentMessages.filter((row) => SMS_FAILURE_STATUSES.has(String(row.status ?? ""))).length;
    const recentSmsActions = recentActions.filter((row) =>
      row.provider === "twilio" &&
      row.suppressed !== true &&
      String(row.action ?? "").includes("sms")
    );
    // The provider-action ledger remains visible when Twilio accepted a request
    // but the local messages write failed, so it closes the missing-row path.
    const smsAttempts = Math.max(messageSmsAttempts, recentSmsActions.length);
    const smsFailures = Math.max(
      messageSmsFailures,
      recentSmsActions.filter((row) => row.internal_status === "failed").length,
    );
    const callsWithoutLeads = accountCalls.filter((row) => {
      const status = String(row.dial_call_status ?? row.status ?? "");
      return MISSED_CALL_STATUSES.has(status) && !row.lead_id && timestamp(row, "created_at")! < leadGraceCutoff;
    }).length;
    const attemptedLeadIds = new Set([
      ...recentMessages.map((row) => row.lead_id).filter((value): value is string => typeof value === "string"),
      ...recentActions
        .filter((row) => row.action === "automatic_missed_call_sms")
        .map((row) => row.resource_id)
        .filter((value): value is string => typeof value === "string"),
    ]);
    const missedCallsWithoutTextAttempt = accountLeads.filter((row) =>
      row.sms_status === "pending" &&
      timestamp(row, "created_at")! >= activitySince &&
      timestamp(row, "created_at")! < smsGraceCutoff &&
      !attemptedLeadIds.has(String(row.id))
    ).length;
    const invalidWebhookSignatures = recentWebhooks.filter((row) => /invalid twilio signature|unsigned\/invalid twilio signature/i.test(String(row.error ?? ""))).length;
    const failedWebhookActions = recentActions.filter((row) => String(row.action).startsWith("webhook_") && row.internal_status === "failed").length;
    const webhookResponseErrors = recentWebhooks.filter((row) => Number(row.response_status) >= 500).length;
    const duplicateEventConflicts = recentActions.filter(containsOperationalConflict).length;
    const recordingOrTranscriptionFailures = recentActions.filter((row) =>
      row.internal_status === "failed" &&
      row.suppressed !== true &&
      row.action !== "scheduled_transcription_retry" &&
      /recording|transcription/.test(String(row.action))
    ).length;
    const latestAction = (action: string) => accountActions
      .filter((row) => row.action === action)
      .sort((a, b) => String(b.last_attempt_at).localeCompare(String(a.last_attempt_at)))[0];
    const latestBillingReconciliation = latestAction("scheduled_billing_reconciliation");
    const billingReconciliationFailures = latestBillingReconciliation?.internal_status === "failed" ? 1 : 0;
    const actionAt = (action: string) => timestamp(latestAction(action) ?? {}, "last_attempt_at");
    const actionOk = (action: string) => {
      const status = latestAction(action)?.internal_status;
      if (status === "failed") return false;
      if (status === "accepted" || status === "succeeded" || status === "reconciled") return true;
      return null;
    };
    const duplicatePhoneNumberCount = accountPhones.filter((row) =>
      typeof row.phone_number === "string" && (phoneUseCounts.get(row.phone_number) ?? 0) > 1
    ).length;

    const health = calculateAccountHealth({
      accountId: account.accountId,
      callsWithoutLeads,
      missedCallsWithoutTextAttempt,
      smsAttempts,
      smsFailures,
      invalidWebhookSignatures,
      webhookProcessingErrors: Math.max(failedWebhookActions, webhookResponseErrors),
      duplicateEventConflicts,
      recordingOrTranscriptionFailures,
      billingReconciliationFailures,
      phoneNumberCount: accountPhones.length,
      primaryPhoneNumberCount: accountPhones.filter((row) => row.is_primary === true).length,
      duplicatePhoneNumberCount,
      operationsMonitoringCronAt: actionAt("scheduled_operations_monitoring"),
      operationsMonitoringCronOk: actionOk("scheduled_operations_monitoring"),
      transcriptionCronAt: actionAt("scheduled_transcription_retry"),
      transcriptionCronOk: actionOk("scheduled_transcription_retry"),
      billingReconciliationAt: actionAt("scheduled_billing_reconciliation"),
      billingReconciliationCronOk: actionOk("scheduled_billing_reconciliation"),
      retentionCronAt: actionAt("scheduled_retention"),
      retentionCronOk: actionOk("scheduled_retention"),
      weeklyDigestCronAt: actionAt("scheduled_weekly_digest"),
      weeklyDigestCronOk: actionOk("scheduled_weekly_digest"),
      billingReconciliationExpected: billingReconciliationExpected(account),
    }, thresholds, now);

    const opsState = deriveOpsState({
      technicalStatus: account.technicalStatus,
      a2pStatus: account.a2pStatus,
      smsEnabled: account.smsEnabled,
      billingStatus: account.billingStatus,
      billingPolicy: account.billingPolicy,
      freeAccessReviewAt: account.freeAccessReviewAt,
      stripeSubscriptionStatus: account.stripeSubscriptionStatus,
      setupFeeStatus: account.setupFeeStatus,
      stripeDefaultPaymentMethodId: account.stripeDefaultPaymentMethodId,
      cancelAtPeriodEnd: account.cancelAtPeriodEnd,
      blockedBy: account.opsBlockedBy,
      blockerNote: account.opsBlockerNote,
      blockedSince: account.opsBlockedSince,
    });
    const twilioWebhookAt = latest(accountWebhooks, "created_at");
    const stripeWebhookAt = latest(accountStripeEvents, "received_at");

    return {
      accountId: account.accountId,
      accountSlug: account.accountSlug,
      businessName: account.businessName,
      accountStatus: account.accountStatus,
      health,
      lastSuccessfulCallAt: latest(accountLeads, "created_at"),
      lastSuccessfulOutboundSmsAt: latest(successfulMessages, "created_at"),
      forwardingVerifiedAt: latest(accountAudits, "created_at"),
      a2pStatus: account.a2pStatus,
      blockerOwner: account.opsBlockedBy,
      blockerNote: account.opsBlockerNote,
      billingState: opsState.labels.billing,
      lastWebhookAt: [twilioWebhookAt, stripeWebhookAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
      operationsMonitoringCronAt: actionAt("scheduled_operations_monitoring"),
      operationsMonitoringCronOk: actionOk("scheduled_operations_monitoring"),
      transcriptionCronAt: actionAt("scheduled_transcription_retry"),
      transcriptionCronOk: actionOk("scheduled_transcription_retry"),
      billingReconciliationAt: actionAt("scheduled_billing_reconciliation"),
      billingReconciliationCronOk: actionOk("scheduled_billing_reconciliation"),
      retentionCronAt: actionAt("scheduled_retention"),
      retentionCronOk: actionOk("scheduled_retention"),
      weeklyDigestCronAt: actionAt("scheduled_weekly_digest"),
      weeklyDigestCronOk: actionOk("scheduled_weekly_digest"),
      smsAttempts,
      smsFailures,
    };
  }).sort((a, b) => {
    const rank = { critical: 0, warning: 1, healthy: 2 } as const;
    return rank[a.health.status] - rank[b.health.status] || a.businessName.localeCompare(b.businessName);
  });

  const unresolvedInvalidSignatures = unresolvedWebhooks.filter((row) => /invalid twilio signature|unsigned\/invalid twilio signature/i.test(String(row.error ?? ""))).length;
  const unresolvedWebhookErrors = unresolvedWebhooks.filter((row) => Number(row.response_status) >= 500).length;

  return { generatedAt, thresholds, rows, unresolvedInvalidSignatures, unresolvedWebhookErrors };
}

import {
  FORWARDING_HEALTH_CHECK_WINDOW_MS,
  forwardingHealthDisplayStatus,
  forwardingHealthFailureText,
  forwardingHealthRetryAt,
  forwardingHealthStatusLabel,
  type ForwardingHealthSummary,
} from "@/lib/forwarding-health";
import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";
import type {
  ForwardingHealthCheck,
  ForwardingHealthCheckFailureReason,
  ForwardingHealthCheckStatus,
} from "./types";

const HEALTH_CHECK_SELECT =
  "id, account_id, phone_number_tested, status, started_at, completed_at, outbound_twilio_call_sid, inbound_twilio_call_sid, failure_reason, raw_event_summary, created_at, updated_at";

function nowIso() {
  return new Date().toISOString();
}

function emptySummary(): ForwardingHealthSummary {
  return {
    latest: null,
    lastPassedAt: null,
    displayStatus: "unknown",
    statusLabel: "Unknown",
    failureText: null,
    canRunAt: null,
  };
}

function isMissingHealthCheckTableError(error: { code?: string; message?: string } | null) {
  if (!error) {
    return false;
  }

  return error.code === "42P01" || error.message?.includes("forwarding_health_checks") === true;
}

function logMissingHealthCheckTable(action: string) {
  console.warn("forwarding_health_checks table is not available; skipping health check action", { action });
}

function healthSummary(latest: ForwardingHealthCheck | null, lastPassedAt: string | null): ForwardingHealthSummary {
  return {
    latest,
    lastPassedAt,
    displayStatus: forwardingHealthDisplayStatus(latest),
    statusLabel: forwardingHealthStatusLabel(latest),
    failureText: forwardingHealthFailureText(latest?.failure_reason ?? null),
    canRunAt: forwardingHealthRetryAt(latest),
  };
}

export async function expirePendingForwardingHealthChecks(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "expirePendingForwardingHealthChecks");

  if (isPlaceholderSupabaseConfig()) {
    return 0;
  }

  const cutoff = new Date(Date.now() - FORWARDING_HEALTH_CHECK_WINDOW_MS).toISOString();
  let query = supabaseAdmin
    .from("forwarding_health_checks")
    .update({
      status: "timeout" satisfies ForwardingHealthCheckStatus,
      completed_at: nowIso(),
      failure_reason: "no_forwarded_call_received" satisfies Exclude<ForwardingHealthCheckFailureReason, null>,
      updated_at: nowIso(),
    })
    .eq("account_id", accountId)
    .eq("status", "pending")
    .lt("started_at", cutoff);

  const { data, error } = await query.select("id");

  if (isMissingHealthCheckTableError(error)) {
    logMissingHealthCheckTable("expire_pending");
    return 0;
  }

  throwIfSupabaseError(error);

  if (data?.length) {
    console.info("health_check_failed", {
      count: data.length,
      failureReason: "no_forwarded_call_received",
    });
  }

  return data?.length ?? 0;
}

export async function getForwardingHealthSummary(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "getForwardingHealthSummary");

  if (isPlaceholderSupabaseConfig()) {
    return emptySummary();
  }

  await expirePendingForwardingHealthChecks(accountId);

  const latestQuery = supabaseAdmin
    .from("forwarding_health_checks")
    .select(HEALTH_CHECK_SELECT)
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(1);

  const lastPassedQuery = supabaseAdmin
    .from("forwarding_health_checks")
    .select("completed_at")
    .eq("account_id", accountId)
    .eq("status", "passed")
    .order("completed_at", { ascending: false })
    .limit(1);

  const [
    { data: latest, error: latestError },
    { data: lastPassed, error: lastPassedError },
  ] = await Promise.all([
    latestQuery.maybeSingle(),
    lastPassedQuery.maybeSingle(),
  ]);

  if (isMissingHealthCheckTableError(latestError)) {
    logMissingHealthCheckTable("summary_latest");
    return emptySummary();
  }

  throwIfSupabaseError(latestError);

  if (isMissingHealthCheckTableError(lastPassedError)) {
    logMissingHealthCheckTable("summary_last_passed");
    return healthSummary((latest ?? null) as ForwardingHealthCheck | null, null);
  }

  throwIfSupabaseError(lastPassedError);

  return healthSummary((latest ?? null) as ForwardingHealthCheck | null, lastPassed?.completed_at ?? null);
}

export async function getLatestForwardingHealthCheck(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "getLatestForwardingHealthCheck");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  let query = supabaseAdmin
    .from("forwarding_health_checks")
    .select(HEALTH_CHECK_SELECT)
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(1);

  const { data, error } = await query.maybeSingle();

  if (isMissingHealthCheckTableError(error)) {
    logMissingHealthCheckTable("latest");
    return null;
  }

  throwIfSupabaseError(error);

  return (data ?? null) as ForwardingHealthCheck | null;
}

export async function createPendingForwardingHealthCheck(phoneNumberTested: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "createPendingForwardingHealthCheck");

  if (shouldSkipDatabaseWrite("forwarding health check insert", { phoneNumberTested, accountId })) {
    return null;
  }

  const timestamp = nowIso();
  const { data, error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .insert({
      account_id: accountId,
      phone_number_tested: phoneNumberTested,
      status: "pending" satisfies ForwardingHealthCheckStatus,
      started_at: timestamp,
      updated_at: timestamp,
    })
    .select(HEALTH_CHECK_SELECT)
    .single();

  throwIfSupabaseError(error);

  return data as ForwardingHealthCheck;
}

export async function markForwardingHealthCheckOutboundCreated(input: {
  accountId: string;
  id: string;
  outboundTwilioCallSid: string;
}) {
  const accountId = assertAccountId(input.accountId, "markForwardingHealthCheckOutboundCreated");

  if (shouldSkipDatabaseWrite("forwarding health check outbound update", input)) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .update({
      outbound_twilio_call_sid: input.outboundTwilioCallSid,
      updated_at: nowIso(),
    })
    .eq("id", input.id)
    .eq("account_id", accountId);

  throwIfSupabaseError(error);
}

export async function markForwardingHealthCheckFailed(input: {
  accountId: string;
  id: string;
  failureReason: Exclude<ForwardingHealthCheckFailureReason, null>;
  rawEventSummary?: Record<string, unknown> | null;
}) {
  const accountId = assertAccountId(input.accountId, "markForwardingHealthCheckFailed");

  if (shouldSkipDatabaseWrite("forwarding health check failed update", input)) {
    return;
  }

  const timestamp = nowIso();
  const { error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .update({
      status: input.failureReason === "twilio_outbound_failed" ? "failed" : "error",
      completed_at: timestamp,
      failure_reason: input.failureReason,
      raw_event_summary: input.rawEventSummary ?? null,
      updated_at: timestamp,
    })
    .eq("id", input.id)
    .eq("account_id", accountId);

  throwIfSupabaseError(error);

  console.info("health_check_failed", { healthCheckId: input.id, failureReason: input.failureReason });
}

export async function findPendingForwardingHealthCheck(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "findPendingForwardingHealthCheck");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const cutoff = new Date(Date.now() - FORWARDING_HEALTH_CHECK_WINDOW_MS).toISOString();
  let query = supabaseAdmin
    .from("forwarding_health_checks")
    .select(HEALTH_CHECK_SELECT)
    .eq("account_id", accountId)
    .eq("status", "pending")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1);

  const { data, error } = await query.maybeSingle();

  if (isMissingHealthCheckTableError(error)) {
    logMissingHealthCheckTable("find_pending");
    return null;
  }

  throwIfSupabaseError(error);

  return (data ?? null) as ForwardingHealthCheck | null;
}

export async function markForwardingHealthCheckPassed(input: {
  accountId: string;
  id: string;
  inboundTwilioCallSid: string | null;
  rawEventSummary: Record<string, unknown>;
}) {
  const accountId = assertAccountId(input.accountId, "markForwardingHealthCheckPassed");

  if (shouldSkipDatabaseWrite("forwarding health check passed update", input)) {
    return;
  }

  const timestamp = nowIso();
  const { error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .update({
      status: "passed" satisfies ForwardingHealthCheckStatus,
      completed_at: timestamp,
      inbound_twilio_call_sid: input.inboundTwilioCallSid,
      failure_reason: null,
      raw_event_summary: input.rawEventSummary,
      updated_at: timestamp,
    })
    .eq("id", input.id)
    .eq("account_id", accountId);

  throwIfSupabaseError(error);

  console.info("health_check_passed", {
    healthCheckId: input.id,
    inboundTwilioCallSid: input.inboundTwilioCallSid,
  });
}

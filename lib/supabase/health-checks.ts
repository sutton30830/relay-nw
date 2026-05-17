import {
  FORWARDING_HEALTH_CHECK_WINDOW_MS,
  forwardingHealthDisplayStatus,
  forwardingHealthFailureText,
  forwardingHealthRetryAt,
  forwardingHealthStatusLabel,
  type ForwardingHealthSummary,
} from "@/lib/forwarding-health";
import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import type {
  ForwardingHealthCheck,
  ForwardingHealthCheckFailureReason,
  ForwardingHealthCheckStatus,
} from "./types";

const HEALTH_CHECK_SELECT =
  "id, phone_number_tested, status, started_at, completed_at, outbound_twilio_call_sid, inbound_twilio_call_sid, failure_reason, raw_event_summary, created_at, updated_at";

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

export async function expirePendingForwardingHealthChecks() {
  if (isPlaceholderSupabaseConfig()) {
    return 0;
  }

  const cutoff = new Date(Date.now() - FORWARDING_HEALTH_CHECK_WINDOW_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .update({
      status: "timeout" satisfies ForwardingHealthCheckStatus,
      completed_at: nowIso(),
      failure_reason: "no_forwarded_call_received" satisfies Exclude<ForwardingHealthCheckFailureReason, null>,
      updated_at: nowIso(),
    })
    .eq("status", "pending")
    .lt("started_at", cutoff)
    .select("id");

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

export async function getForwardingHealthSummary() {
  if (isPlaceholderSupabaseConfig()) {
    return emptySummary();
  }

  await expirePendingForwardingHealthChecks();

  const { data: latest, error: latestError } = await supabaseAdmin
    .from("forwarding_health_checks")
    .select(HEALTH_CHECK_SELECT)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (isMissingHealthCheckTableError(latestError)) {
    logMissingHealthCheckTable("summary_latest");
    return emptySummary();
  }

  throwIfSupabaseError(latestError);

  const { data: lastPassed, error: lastPassedError } = await supabaseAdmin
    .from("forwarding_health_checks")
    .select("completed_at")
    .eq("status", "passed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (isMissingHealthCheckTableError(lastPassedError)) {
    logMissingHealthCheckTable("summary_last_passed");
    return healthSummary((latest ?? null) as ForwardingHealthCheck | null, null);
  }

  throwIfSupabaseError(lastPassedError);

  return healthSummary((latest ?? null) as ForwardingHealthCheck | null, lastPassed?.completed_at ?? null);
}

export async function getLatestForwardingHealthCheck() {
  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .select(HEALTH_CHECK_SELECT)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (isMissingHealthCheckTableError(error)) {
    logMissingHealthCheckTable("latest");
    return null;
  }

  throwIfSupabaseError(error);

  return (data ?? null) as ForwardingHealthCheck | null;
}

export async function createPendingForwardingHealthCheck(phoneNumberTested: string) {
  if (shouldSkipDatabaseWrite("forwarding health check insert", { phoneNumberTested })) {
    return null;
  }

  const timestamp = nowIso();
  const { data, error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .insert({
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

export async function markForwardingHealthCheckOutboundCreated(id: string, outboundTwilioCallSid: string) {
  if (shouldSkipDatabaseWrite("forwarding health check outbound update", { id })) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .update({
      outbound_twilio_call_sid: outboundTwilioCallSid,
      updated_at: nowIso(),
    })
    .eq("id", id);

  throwIfSupabaseError(error);
}

export async function markForwardingHealthCheckFailed(
  id: string,
  failureReason: Exclude<ForwardingHealthCheckFailureReason, null>,
  rawEventSummary?: Record<string, unknown> | null,
) {
  if (shouldSkipDatabaseWrite("forwarding health check failed update", { id, failureReason })) {
    return;
  }

  const timestamp = nowIso();
  const { error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .update({
      status: failureReason === "twilio_outbound_failed" ? "failed" : "error",
      completed_at: timestamp,
      failure_reason: failureReason,
      raw_event_summary: rawEventSummary ?? null,
      updated_at: timestamp,
    })
    .eq("id", id);

  throwIfSupabaseError(error);

  console.info("health_check_failed", { healthCheckId: id, failureReason });
}

export async function findPendingForwardingHealthCheck() {
  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const cutoff = new Date(Date.now() - FORWARDING_HEALTH_CHECK_WINDOW_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("forwarding_health_checks")
    .select(HEALTH_CHECK_SELECT)
    .eq("status", "pending")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (isMissingHealthCheckTableError(error)) {
    logMissingHealthCheckTable("find_pending");
    return null;
  }

  throwIfSupabaseError(error);

  return (data ?? null) as ForwardingHealthCheck | null;
}

export async function markForwardingHealthCheckPassed(input: {
  id: string;
  inboundTwilioCallSid: string | null;
  rawEventSummary: Record<string, unknown>;
}) {
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
    .eq("id", input.id);

  throwIfSupabaseError(error);

  console.info("health_check_passed", {
    healthCheckId: input.id,
    inboundTwilioCallSid: input.inboundTwilioCallSid,
  });
}

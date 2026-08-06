import {
  failurePresentation,
  providerFailureCode,
  sanitizeProviderDiagnostic,
  type ProviderActionStatus,
  type ProviderName,
  type RetryEligibility,
} from "@/lib/provider-actions";
import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";

export type ProviderActionEvent = {
  id: string;
  accountId: string;
  action: string;
  provider: ProviderName;
  providerIdentifier: string | null;
  resourceType: string | null;
  resourceId: string | null;
  internalStatus: ProviderActionStatus;
  providerStatus: string | null;
  failureCode: string | null;
  customerExplanation: string;
  diagnosticDetail: string | null;
  retryEligibility: RetryEligibility;
  attemptCount: number;
  lastAttemptAt: string;
  recommendedNextAction: string;
  customerVisible: boolean;
  suppressed: boolean;
  reconciledAt: string | null;
  idempotencyKey: string;
};

export async function recordProviderAction(input: {
  accountId: string;
  action: string;
  provider: ProviderName;
  idempotencyKey: string;
  providerIdentifier?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  internalStatus: ProviderActionStatus;
  providerStatus?: string | null;
  failureCode?: string | null;
  diagnosticDetail?: unknown;
  customerExplanation?: string;
  retryEligibility?: RetryEligibility;
  recommendedNextAction?: string;
  customerVisible?: boolean;
  expectedSuppression?: boolean;
  countAttempt?: boolean;
}) {
  const accountId = assertAccountId(input.accountId, "recordProviderAction");
  const failureCode = input.failureCode ?? providerFailureCode(input.diagnosticDetail);
  const presentation = failurePresentation({
    provider: input.provider,
    action: input.action,
    providerStatus: input.providerStatus,
    failureCode,
    expectedSuppression: input.expectedSuppression,
  });

  if (shouldSkipDatabaseWrite("provider action event", { ...input, diagnosticDetail: undefined })) return null;

  const { data, error } = await supabaseAdmin.rpc("record_provider_action_event", {
    p_account_id: accountId,
    p_action: input.action.slice(0, 100),
    p_provider: input.provider,
    p_idempotency_key: input.idempotencyKey.slice(0, 240),
    p_provider_identifier: input.providerIdentifier?.slice(0, 180) ?? null,
    p_resource_type: input.resourceType?.slice(0, 80) ?? null,
    p_resource_id: input.resourceId?.slice(0, 180) ?? null,
    p_internal_status: input.expectedSuppression ? "suppressed" : input.internalStatus,
    p_provider_status: input.providerStatus?.slice(0, 100) ?? null,
    p_failure_code: failureCode?.slice(0, 80) ?? null,
    p_customer_explanation: (input.customerExplanation ?? presentation.customerExplanation).slice(0, 500),
    p_diagnostic_detail: input.diagnosticDetail == null ? null : sanitizeProviderDiagnostic(input.diagnosticDetail),
    p_retry_eligibility: input.retryEligibility ?? presentation.retryEligibility,
    p_recommended_next_action: (input.recommendedNextAction ?? presentation.recommendedNextAction).slice(0, 500),
    p_customer_visible: input.customerVisible ?? input.internalStatus === "failed",
    p_suppressed: input.expectedSuppression ?? presentation.suppressed,
    p_count_attempt: input.countAttempt ?? false,
  });

  throwIfSupabaseError(error);
  return typeof data === "string" ? data : null;
}

function mapProviderAction(row: Record<string, unknown>): ProviderActionEvent {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    action: String(row.action),
    provider: row.provider as ProviderName,
    providerIdentifier: row.provider_identifier as string | null,
    resourceType: row.resource_type as string | null,
    resourceId: row.resource_id as string | null,
    internalStatus: row.internal_status as ProviderActionStatus,
    providerStatus: row.provider_status as string | null,
    failureCode: row.failure_code as string | null,
    customerExplanation: String(row.customer_explanation),
    diagnosticDetail: row.diagnostic_detail as string | null,
    retryEligibility: row.retry_eligibility as RetryEligibility,
    attemptCount: Number(row.attempt_count),
    lastAttemptAt: String(row.last_attempt_at),
    recommendedNextAction: String(row.recommended_next_action),
    customerVisible: Boolean(row.customer_visible),
    suppressed: Boolean(row.suppressed),
    reconciledAt: row.reconciled_at as string | null,
    idempotencyKey: String(row.idempotency_key),
  };
}

export async function listProviderActionsForAccount(accountIdInput: string, limit = 50) {
  const accountId = assertAccountId(accountIdInput, "listProviderActionsForAccount");
  if (isPlaceholderSupabaseConfig()) return [];
  const { data, error } = await supabaseAdmin
    .from("provider_action_events")
    .select("*")
    .eq("account_id", accountId)
    .order("last_attempt_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 100)));
  throwIfSupabaseError(error);
  return (data ?? []).map((row) => mapProviderAction(row as Record<string, unknown>));
}

export async function getProviderActionByKey(accountIdInput: string, idempotencyKey: string) {
  const accountId = assertAccountId(accountIdInput, "getProviderActionByKey");
  if (isPlaceholderSupabaseConfig()) return null;
  const { data, error } = await supabaseAdmin
    .from("provider_action_events")
    .select("*")
    .eq("account_id", accountId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  throwIfSupabaseError(error);
  return data ? mapProviderAction(data as Record<string, unknown>) : null;
}

export async function listCustomerVisibleProviderActions(accountIdInput: string, resourceId: string) {
  const accountId = assertAccountId(accountIdInput, "listCustomerVisibleProviderActions");
  if (isPlaceholderSupabaseConfig()) return [];
  const { data, error } = await supabaseAdmin
    .from("provider_action_events")
    .select("*")
    .eq("account_id", accountId)
    .eq("resource_id", resourceId)
    .eq("customer_visible", true)
    .eq("suppressed", false)
    .order("last_attempt_at", { ascending: false })
    .limit(20);
  throwIfSupabaseError(error);
  return (data ?? []).map((row) => mapProviderAction(row as Record<string, unknown>));
}

export async function claimProviderActionRetry(input: {
  accountId: string;
  idempotencyKey: string;
  staleBefore: string;
}) {
  const accountId = assertAccountId(input.accountId, "claimProviderActionRetry");
  const { data, error } = await supabaseAdmin.rpc("claim_provider_action_retry", {
    p_account_id: accountId,
    p_idempotency_key: input.idempotencyKey,
    p_stale_before: input.staleBefore,
  });
  throwIfSupabaseError(error);
  return Boolean(data);
}

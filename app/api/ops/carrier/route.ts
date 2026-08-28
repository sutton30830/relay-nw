import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import { deriveA2pSyncDecision } from "@/lib/a2p-sync";
import {
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  recordProviderAction,
  updateAccountSettings,
  upsertCarrierProfile,
} from "@/lib/supabase";
import { getTelephonyProvider } from "@/lib/telephony/registry";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?carrier=${result}`);
}

function campaignErrorSummary(value: unknown, providerName: string) {
  if (!Array.isArray(value)) return null;
  const messages = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message.trim();
      }
      if (typeof record.description === "string" && record.description.trim()) {
        return record.description.trim();
      }
      if (typeof record.error_code === "number" || typeof record.error_code === "string") {
        return `${providerName} error ${String(record.error_code)}`;
      }
      if (typeof record.code === "number" || typeof record.code === "string") {
        return `${providerName} error ${String(record.code)}`;
      }
      return null;
    })
    .filter((message): message is string => Boolean(message));
  return messages.length ? messages.join(" ").slice(0, 240) : null;
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.a2pSync);

  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);
  const messagingServiceSid = String(form.get("messaging_service_sid") ?? "").trim();
  const campaignSid = String(form.get("twilio_campaign_sid") ?? "").trim();
  if (!slug) redirect("/ops");
  if (
    !/^MG[0-9a-fA-F]{32}$/.test(messagingServiceSid) ||
    !/^QE[0-9a-fA-F]{32}$/.test(campaignSid)
  ) {
    go(slug, "invalid_ids");
  }

  const account = await getOpsAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  if (!account.relayNumber) go(slug, "number_required");
  const provider = getTelephonyProvider();
  const actionKey = `a2p_sync:${campaignSid}`;
  const recordCarrierAction = async (event: Parameters<typeof recordProviderAction>[0]) => {
    if (typeof recordProviderAction !== "function") return;
    try {
      await recordProviderAction(event);
    } catch (recordError) {
      console.error("Could not record A2P provider action evidence", {
        accountId: account.accountId,
        campaignSid,
        error: recordError instanceof Error ? recordError.message : recordError,
      });
    }
  };

  await recordCarrierAction({
      accountId: account.accountId,
      action: "a2p_status_sync",
      provider: provider.identity.id,
      idempotencyKey: actionKey,
      providerIdentifier: campaignSid,
      resourceType: "carrier_profile",
      resourceId: campaignSid,
      internalStatus: "processing",
      providerStatus: "requesting",
      customerExplanation: "Relay is checking carrier registration status.",
      retryEligibility: "manual",
      recommendedNextAction: `Wait for the current ${provider.identity.displayName} lookup to finish.`,
      customerVisible: false,
      countAttempt: true,
  });

  let external;
  try {
    external = await provider.readMessagingRegistrationEvidence({
      messagingServiceReference: messagingServiceSid,
      registrationReference: campaignSid,
      phoneNumber: account.relayNumber,
    });
  } catch (error) {
    console.error("Twilio A2P status synchronization failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    await recordCarrierAction({
        accountId: account.accountId,
        action: "a2p_status_sync",
        provider: provider.identity.id,
        idempotencyKey: actionKey,
        providerIdentifier: campaignSid,
        resourceType: "carrier_profile",
        resourceId: campaignSid,
        internalStatus: "failed",
        providerStatus: "lookup_failed",
        diagnosticDetail: error,
        customerExplanation: "Relay could not check the latest carrier registration status.",
        retryEligibility: "manual",
        recommendedNextAction: "Confirm the Twilio campaign identifiers and retry the status check.",
        customerVisible: true,
    });
    go(slug, "sync_failed");
  }

  const next = deriveA2pSyncDecision(external);
  if (!next) go(slug, "unknown_status");

  const externalStatus = String(external.registrationStatus).toUpperCase();
  const errorSummary = campaignErrorSummary(external.issues, provider.identity.displayName);
  const detail = externalStatus === "FAILED" || externalStatus === "SUSPENDED"
    ? errorSummary ?? next.detail
    : next.detail;

  try {
    await upsertCarrierProfile(account.accountId, {
      status: next.profile,
      twilio_brand_sid: external.brandRegistrationReference,
      twilio_campaign_sid: campaignSid,
      messaging_service_sid: messagingServiceSid,
      status_detail: detail,
    });
    await updateAccountSettings(account.accountId, {
      a2p_registration_status: next.a2p,
    });

    const summary =
      `Synchronized Twilio A2P evidence: campaign ${externalStatus}; account ${next.a2p}`;
    await recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      events: [{ action: "carrier.status_synchronized", summary }],
    });
    await recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: "carrier.status_synchronized",
      summary,
    });
  } catch (error) {
    console.error("Twilio A2P status persistence failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    await recordCarrierAction({
        accountId: account.accountId,
        action: "a2p_status_sync",
        provider: "supabase",
        idempotencyKey: actionKey,
        providerIdentifier: campaignSid,
        resourceType: "carrier_profile",
        resourceId: campaignSid,
        internalStatus: "failed",
        providerStatus: externalStatus,
        diagnosticDetail: error,
        customerExplanation: "Twilio returned a status, but Relay could not save it yet.",
        retryEligibility: "manual",
        recommendedNextAction: "Retry the same status synchronization; do not create another campaign.",
        customerVisible: true,
    });
    go(slug, "save_failed");
  }

  const blocked = next.a2p === "rejected" || next.a2p === "needs_attention";
  await recordCarrierAction({
      accountId: account.accountId,
      action: "a2p_status_sync",
      provider: provider.identity.id,
      idempotencyKey: actionKey,
      providerIdentifier: campaignSid,
      resourceType: "carrier_profile",
      resourceId: campaignSid,
      internalStatus: blocked ? "failed" : "succeeded",
      providerStatus: externalStatus,
      failureCode: blocked ? externalStatus : null,
      diagnosticDetail: blocked ? detail : null,
      customerExplanation: blocked
        ? "Carrier registration needs attention before Relay can send customer texts."
        : next.detail,
      retryEligibility: blocked ? "manual" : "never",
      recommendedNextAction: blocked
        ? "Review Twilio's campaign details, correct the registration, then synchronize again."
        : "No action is needed unless Twilio changes the campaign status.",
      customerVisible: blocked,
  });

  go(slug, externalStatus.toLowerCase());
}

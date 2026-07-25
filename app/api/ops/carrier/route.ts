import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import { deriveA2pSyncDecision } from "@/lib/a2p-sync";
import {
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountSettings,
  upsertCarrierProfile,
} from "@/lib/supabase";
import { fetchA2pRegistrationEvidence } from "@/lib/twilio";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?carrier=${result}`);
}

function campaignErrorSummary(value: unknown) {
  if (!Array.isArray(value)) return null;
  const messages = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (typeof record.description === "string" && record.description.trim()) {
        return record.description.trim();
      }
      if (typeof record.error_code === "number" || typeof record.error_code === "string") {
        return `Twilio error ${String(record.error_code)}`;
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

  let external;
  try {
    external = await fetchA2pRegistrationEvidence(
      messagingServiceSid,
      campaignSid,
      account.relayNumber,
    );
  } catch (error) {
    console.error("Twilio A2P status synchronization failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    go(slug, "sync_failed");
  }

  const next = deriveA2pSyncDecision(external);
  if (!next) go(slug, "unknown_status");

  const externalStatus = String(external.campaignStatus).toUpperCase();
  const errorSummary = campaignErrorSummary(external.errors);
  const detail = externalStatus === "FAILED" || externalStatus === "SUSPENDED"
    ? errorSummary ?? next.detail
    : next.detail;

  try {
    await upsertCarrierProfile(account.accountId, {
      status: next.profile,
      twilio_brand_sid: external.brandRegistrationSid,
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
    go(slug, "save_failed");
  }

  go(slug, externalStatus.toLowerCase());
}

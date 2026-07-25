import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountSettings,
  upsertCarrierProfile,
} from "@/lib/supabase";
import { fetchA2pCampaignStatus } from "@/lib/twilio";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?carrier=${result}`);
}

function mapCampaignStatus(value: string | null | undefined) {
  const normalized = (value ?? "").toUpperCase();
  if (normalized === "VERIFIED") {
    return { profile: "approved", a2p: "approved" } as const;
  }
  if (normalized === "FAILED" || normalized === "SUSPENDED") {
    return { profile: "rejected", a2p: "rejected" } as const;
  }
  if (
    normalized === "PENDING" ||
    normalized === "IN_PROGRESS" ||
    normalized === "IN_REVIEW"
  ) {
    return { profile: "in_progress", a2p: "in_progress" } as const;
  }
  return null;
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

  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");

  let external;
  try {
    external = await fetchA2pCampaignStatus(messagingServiceSid, campaignSid);
  } catch (error) {
    console.error("Twilio A2P status synchronization failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    go(slug, "sync_failed");
  }

  const next = mapCampaignStatus(external.campaignStatus);
  if (!next) go(slug, "unknown_status");

  const externalStatus = String(external.campaignStatus).toUpperCase();
  const errorSummary = campaignErrorSummary(external.errors);
  const detail = externalStatus === "VERIFIED"
    ? "Twilio reports this A2P campaign as verified."
    : externalStatus === "FAILED" || externalStatus === "SUSPENDED"
      ? errorSummary ?? "Twilio reports that this A2P campaign needs attention."
      : "Twilio or the carrier is reviewing this A2P campaign.";

  try {
    await upsertCarrierProfile(account.accountId, {
      status: next.profile,
      twilio_campaign_sid: campaignSid,
      messaging_service_sid: messagingServiceSid,
      status_detail: detail,
    });
    await updateAccountSettings(account.accountId, {
      a2p_registration_status: next.a2p,
    });

    const summary = `Synchronized Twilio A2P campaign status: ${externalStatus}`;
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

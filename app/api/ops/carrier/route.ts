import { redirect } from "next/navigation";
import { after } from "next/server";
import { activateStripeTrialForAccount } from "@/lib/billing-activation";
import { requirePlatformOperatorWrite } from "@/lib/auth";
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

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorWrite();
  if (operator.role === "support") redirect("/ops?error=forbidden");

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
  const detail = externalStatus === "VERIFIED"
    ? "Twilio reports this A2P campaign as verified."
    : externalStatus === "FAILED" || externalStatus === "SUSPENDED"
      ? "Twilio reports that this A2P campaign needs attention."
      : "Twilio or the carrier is reviewing this A2P campaign.";

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

  if (next.a2p === "approved") {
    after(async () => {
      try {
        await activateStripeTrialForAccount(account.accountId);
      } catch (error) {
        console.error("Deferred trial activation after A2P synchronization failed", {
          accountId: account.accountId,
          error: error instanceof Error ? error.message : error,
        });
      }
    });
  }

  go(slug, externalStatus.toLowerCase());
}

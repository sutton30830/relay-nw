import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { sendCustomerPasswordInvite } from "@/lib/customer-invitations";
import { env } from "@/lib/env";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  getSetupRequestById,
  markSetupRequestOnboarded,
  provisionAccount,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateSetupRequestStatus,
  type SetupRequestStatus,
} from "@/lib/supabase";

const VALID_STATUSES = new Set<SetupRequestStatus>(["new", "contacted", "onboarded", "closed"]);

function readString(formData: FormData, key: string, maxLength = 200) {
  return String(formData.get(key) ?? "").trim().slice(0, maxLength);
}

function slugify(value: string, requestId: string) {
  const base = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "customer";
  return `${base}-${requestId.replaceAll("-", "").slice(0, 8)}`;
}

function go(result: string): never {
  redirect(`/ops?request_result=${encodeURIComponent(result)}#new-requests`);
}

function resultResponse(request: Request, result: string) {
  return Response.redirect(new URL(`/ops?request_result=${encodeURIComponent(result)}#new-requests`, request.url), 303);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.setupRequestAccept);
  const formData = await request.formData();
  const id = readString(formData, "id", 80);
  const action = readString(formData, "action", 40) || "status";

  if (!id) go("invalid");

  if (action === "status") {
    const status = readString(formData, "status", 30) as SetupRequestStatus;
    if (!VALID_STATUSES.has(status)) go("invalid");
    try {
      await updateSetupRequestStatus(id, status);
    } catch (error) {
      console.error("Setup request status update failed", { id, status, error });
      go("save_failed");
    }
    redirect("/ops?queue=onboarding#new-requests");
  }

  const setupRequest = await getSetupRequestById(id);
  if (!setupRequest) go("not_found");

  const ownerEmail = (readString(formData, "owner_email") || setupRequest.owner_email || "").toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(ownerEmail)) go("email_required");

  if (action === "resend_invite") {
    try {
      await sendCustomerPasswordInvite(ownerEmail);
      await recordPlatformAuditEvent({
        actorUserId: operator.userId,
        actorEmail: operator.email,
        targetAccountId: setupRequest.account_id,
        action: "customer.invite.resent",
        summary: `Resent customer password setup to ${ownerEmail}`,
      });
      return resultResponse(request, "invite_sent");
    } catch (error) {
      console.error("Customer invitation resend failed", { id, ownerEmail, error });
      return resultResponse(request, "invite_failed");
    }
  }

  if (action !== "accept") go("invalid");
  if (setupRequest.account_id) go("already_onboarded");

  const businessName = readString(formData, "business_name") || setupRequest.business_name || setupRequest.name || "New customer";
  const ownerName = readString(formData, "owner_name") || setupRequest.owner_name || "";
  const businessType = readString(formData, "business_type") || setupRequest.business_type || "Other";
  const publicBusinessNumber = readString(formData, "public_business_number") || setupRequest.public_business_number || "";

  try {
    const accountId = await provisionAccount({
      slug: slugify(businessName, setupRequest.id),
      businessName,
      ownerName,
      ownerEmail,
      ownerPhoneNumber: setupRequest.phone,
      businessType,
      publicBusinessNumber,
      intakeUrl: `${env.appBaseUrl}/intake`,
      schedulingUrl: null,
      callMode: "forwarding",
      smsEnabled: false,
      relayPhoneNumber: null,
    });
    if (!accountId) throw new Error("Account provisioning returned no account ID.");

    await markSetupRequestOnboarded(setupRequest.id, accountId);
    await recordAccountAuditEvents({
      accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      events: [{ action: "account.created_from_request", summary: `Accepted setup request and invited ${ownerEmail}` }],
    });
    await recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: accountId,
      action: "account.created_from_request",
      summary: `Created ${businessName} from setup request for ${ownerEmail}`,
    });

    try {
      await sendCustomerPasswordInvite(ownerEmail);
    } catch (error) {
      console.error("Account created but invitation delivery failed", { accountId, ownerEmail, error });
      return resultResponse(request, "created_invite_failed");
    }

    return Response.redirect(new URL(`/ops/accounts/${encodeURIComponent(slugify(businessName, setupRequest.id))}?created=1`, request.url), 303);
  } catch (error) {
    console.error("Setup request acceptance failed", { id, ownerEmail, error });
    return resultResponse(request, "accept_failed");
  }
}

import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import { env } from "@/lib/env";
import { getTelephonyProvider } from "@/lib/telephony/registry";
import {
  assignPrimaryAccountPhoneNumber,
  clearMessagingOnboardingEvidence,
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

function go(slug: string, value: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?number=${value}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.assignExistingNumber);
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim();
  const phoneNumber = String(form.get("phone_number") ?? "").trim();
  const action = String(form.get("action") ?? "attach_existing");
  if (!slug) redirect("/ops");
  if (!/^\+1\d{10}$/.test(phoneNumber)) go(slug, "invalid");
  if (action !== "attach_existing") go(slug, "invalid_action");
  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  try {
    const provider = getTelephonyProvider();
    const configured = await provider.configureNumber({
      phoneNumber,
      webhooks: {
        voice: {
          url: `${env.appBaseUrl}/api/twilio/voice`,
          fallbackUrl: `${env.appBaseUrl}/api/twilio/voice`,
        },
        messaging: { url: `${env.appBaseUrl}/api/twilio/sms` },
      },
    });
    const assignment = await assignPrimaryAccountPhoneNumber({
      accountId: account.accountId,
      phoneNumber: configured.phoneNumber,
      twilioSid: configured.numberId.value,
    });
    if (assignment.numberChanged) {
      await clearMessagingOnboardingEvidence(account.accountId);
    }
    const summary = assignment.numberChanged
      ? `Assigned Relay number ${configured.phoneNumber}; call capture must be reconfirmed on the new routing configuration`
      : `Confirmed Relay number ${configured.phoneNumber}`;
    await recordAccountAuditEvents({ accountId: account.accountId, actorUserId: operator.userId, actorEmail: operator.email, events: [{ action: "provisioning.number_assigned", summary }] });
    await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: "provisioning.number_assigned", summary });
  } catch (error) {
    console.error("Relay number assignment failed", { accountId: account.accountId, error: error instanceof Error ? error.message : error });
    go(account.accountSlug, "failed");
  }
  go(account.accountSlug, "assigned");
}

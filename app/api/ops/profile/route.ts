import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountSettings,
  type AccountSettingsUpdate,
} from "@/lib/supabase";

// The operator's pen: Relay can enter or correct a customer's business details
// on their behalf (concierge onboarding), instead of leaving a 24-field form as
// customer homework. Same data model the owner's Settings writes — audited as
// entered by Relay.

function value(form: FormData, key: string, max = 200) {
  return String(form.get(key) ?? "").trim().slice(0, max);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  const form = await request.formData();
  const slug = value(form, "account_slug", 80);
  if (!slug) redirect("/ops");

  const account = await getOpsAccountBySlug(slug);
  if (!account) redirect("/ops");

  const businessName = value(form, "business_name", 120);
  const ownerName = value(form, "owner_name", 120);
  const ownerEmail = value(form, "owner_email").toLowerCase();
  const ownerPhone = value(form, "owner_phone_number", 30);
  const publicNumber = value(form, "public_business_number", 30);
  const businessType = value(form, "business_type", 40);
  const callMode = value(form, "call_mode", 20);
  const schedulingUrl = value(form, "scheduling_url", 500);

  if (!businessName) {
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=invalid`);
  }
  if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=invalid`);
  }
  if (schedulingUrl && !/^https?:\/\//.test(schedulingUrl)) {
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=invalid`);
  }

  const update: AccountSettingsUpdate = {
    business_name: businessName,
    owner_name: ownerName || null,
    owner_email: ownerEmail || null,
    public_business_number: publicNumber ? normalizePhoneNumber(publicNumber) : null,
    business_type: businessType || null,
    scheduling_url: schedulingUrl || null,
  };
  if (ownerPhone) update.owner_phone_number = normalizePhoneNumber(ownerPhone);
  if (callMode === "forwarding" || callMode === "direct") update.call_mode = callMode;

  const voiceMessage = value(form, "missed_call_voice_message", 600);
  update.missed_call_voice_message = voiceMessage || null;
  const dialTimeout = Number(value(form, "dial_timeout_seconds", 5));
  if (Number.isInteger(dialTimeout) && dialTimeout >= 5 && dialTimeout <= 60) {
    update.dial_timeout_seconds = dialTimeout;
  }
  const voicemailMax = Number(value(form, "voicemail_max_seconds", 5));
  if (Number.isInteger(voicemailMax) && voicemailMax >= 10 && voicemailMax <= 300) {
    update.voicemail_max_seconds = voicemailMax;
  }

  try {
    await updateAccountSettings(account.accountId, update);
  } catch (error) {
    console.error("Ops profile update failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=save_failed`);
  }

  const summary = `Relay entered business details for ${businessName}`;
  await recordAccountAuditEvents({
    accountId: account.accountId,
    actorUserId: operator.userId,
    actorEmail: operator.email,
    events: [{ action: "ops.profile_updated", summary }],
  });
  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    targetAccountId: account.accountId,
    action: "ops.profile_updated",
    summary,
  });

  redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=saved`);
}

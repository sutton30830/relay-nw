import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { normalizePhoneNumber } from "@/lib/phone";
import { diffSettingsForAudit, type AuditableSettings } from "@/lib/audit";
import {
  getA2pRegistrationStatus,
  recordAccountAuditEvents,
  updateAccountSettings,
  type AccountSettingsUpdate,
} from "@/lib/supabase";

const LIMITS = {
  dialTimeoutSeconds: { min: 5, max: 60 },
  voicemailMaxSeconds: { min: 10, max: 300 },
  cooldownHours: { min: 1, max: 168 },
  typicalJobValueDollars: { min: 0, max: 1000000 },
};

function readString(formData: FormData, key: string, maxLength = 500) {
  return String(formData.get(key) ?? "").trim().slice(0, maxLength);
}

function readNumber(formData: FormData, key: string, bounds: { min: number; max: number }) {
  const value = Number(readString(formData, key, 10));

  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return null;
  }

  return value;
}

function readOptionalDollarCents(formData: FormData, key: string, bounds: { min: number; max: number }) {
  const raw = readString(formData, key, 20);

  if (!raw) {
    return null;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    return undefined;
  }

  return Math.round(value * 100);
}

export async function POST(request: Request) {
  const session = await requireAccountUser();

  if (session.role === "viewer") {
    redirect("/settings?error=forbidden");
  }

  const formData = await request.formData();

  const businessName = readString(formData, "business_name", 120);
  const ownerName = readString(formData, "owner_name", 120);
  const ownerPhone = normalizePhoneNumber(readString(formData, "owner_phone_number", 30));
  const ownerEmail = readString(formData, "owner_email", 200).toLowerCase();
  const publicBusinessNumber = normalizePhoneNumber(readString(formData, "public_business_number", 30));
  const legalBusinessName = readString(formData, "legal_business_name", 160);
  const businessType = readString(formData, "business_type", 40);
  const businessIndustry = readString(formData, "business_industry", 80);
  const websiteUrl = readString(formData, "website_url", 500);
  const addressLine1 = readString(formData, "address_line_1", 160);
  const addressLine2 = readString(formData, "address_line_2", 160);
  const addressCity = readString(formData, "address_city", 100);
  const addressRegion = readString(formData, "address_region", 40).toUpperCase();
  const addressPostalCode = readString(formData, "address_postal_code", 20);
  const businessHours = readString(formData, "business_hours", 1000);
  const implementationNotes = readString(formData, "implementation_notes", 2000);
  const greetingPreference = readString(formData, "greeting_preference", 20);
  const schedulingUrl = readString(formData, "scheduling_url", 500);
  const smsTemplate = readString(formData, "sms_template", 600);
  // One reply per line; blank lines dropped, each capped, at most six. Empty
  // means "use the shared defaults", stored as null.
  const quickReplies = String(formData.get("quick_replies") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => line.slice(0, 200));
  const voiceMessage = readString(formData, "missed_call_voice_message", 600);
  const greetingAudioUrl = readString(formData, "missed_call_greeting_audio_url", 500);
  const dialTimeout = readNumber(formData, "dial_timeout_seconds", LIMITS.dialTimeoutSeconds);
  const voicemailMax = readNumber(formData, "voicemail_max_seconds", LIMITS.voicemailMaxSeconds);
  const cooldownHours = readNumber(formData, "missed_call_sms_cooldown_hours", LIMITS.cooldownHours);
  const typicalJobValueCents = readOptionalDollarCents(
    formData,
    "typical_job_value_dollars",
    LIMITS.typicalJobValueDollars,
  );

  if (
    !businessName ||
    !ownerName ||
    !ownerPhone ||
    !ownerEmail ||
    !publicBusinessNumber ||
    !businessType ||
    !["generated", "recorded"].includes(greetingPreference) ||
    dialTimeout === null ||
    voicemailMax === null ||
    cooldownHours === null ||
    typeof typicalJobValueCents === "undefined"
  ) {
    redirect("/settings?error=invalid");
  }

  if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    redirect("/settings?error=invalid");
  }

  if (schedulingUrl && !/^https?:\/\//.test(schedulingUrl)) {
    redirect("/settings?error=invalid");
  }

  if (websiteUrl && !/^https?:\/\//.test(websiteUrl)) redirect("/settings?error=invalid");

  if (greetingAudioUrl && !/^https:\/\//.test(greetingAudioUrl)) {
    redirect("/settings?error=invalid");
  }

  const update: AccountSettingsUpdate = {
    business_name: businessName,
    owner_phone_number: ownerPhone,
    owner_email: ownerEmail || null,
    owner_name: ownerName,
    legal_business_name: legalBusinessName || null,
    public_business_number: publicBusinessNumber,
    business_type: businessType,
    business_industry: businessIndustry || null,
    website_url: websiteUrl || null,
    address_line_1: addressLine1 || null,
    address_line_2: addressLine2 || null,
    address_city: addressCity || null,
    address_region: addressRegion || null,
    address_postal_code: addressPostalCode || null,
    address_country: "US",
    business_hours: businessHours ? { summary: businessHours } : null,
    implementation_notes: implementationNotes || null,
    greeting_preference: greetingPreference as "generated" | "recorded",
    scheduling_url: schedulingUrl || null,
    sms_template: smsTemplate || null,
    quick_reply_templates: quickReplies.length ? quickReplies : null,
    missed_call_voice_message: voiceMessage || null,
    missed_call_greeting_audio_url: greetingAudioUrl || null,
    dial_timeout_seconds: dialTimeout,
    voicemail_max_seconds: voicemailMax,
    missed_call_sms_cooldown_hours: cooldownHours,
    typical_job_value_cents: typicalJobValueCents,
  };

  // Only the owner can flip texting on/off — it is the compliance-sensitive switch.
  if (session.role === "owner") {
    const wantsSmsEnabled = formData.get("sms_enabled") === "on";

    if (wantsSmsEnabled && !session.account.smsEnabled) {
      // Turning texting ON requires an approved A2P campaign. Fail closed on
      // lookup failure: a status we cannot read is not an approved status.
      const a2pStatus = await getA2pRegistrationStatus(session.accountId);

      if (a2pStatus !== "approved") {
        redirect("/settings?error=a2p_not_approved");
      }
    }

    update.sms_enabled = wantsSmsEnabled;
  }

  try {
    await updateAccountSettings(session.accountId, update);
  } catch (error) {
    console.error("Settings update failed", {
      accountId: session.accountId,
      error: error instanceof Error ? error.message : error,
    });
    redirect("/settings?error=save_failed");
  }

  // Audit trail: record what actually changed, with the SMS master switch called
  // out explicitly. Non-fatal — a logging failure must not fail the save.
  const before: AuditableSettings = {
    smsEnabled: session.account.smsEnabled,
    businessName: session.account.businessName,
    ownerPhoneNumber: session.account.ownerPhoneNumber,
    ownerEmail: session.account.ownerEmail,
    schedulingUrl: session.account.schedulingUrl,
    smsTemplate: session.account.smsTemplate,
    quickReplyTemplates: session.account.quickReplyTemplates,
    missedCallVoiceMessage: session.account.missedCallVoiceMessage,
    missedCallGreetingAudioUrl: session.account.missedCallGreetingAudioUrl,
    dialTimeoutSeconds: session.account.dialTimeoutSeconds,
    voicemailMaxSeconds: session.account.voicemailMaxSeconds,
    missedCallSmsCooldownHours: session.account.missedCallSmsCooldownHours,
    typicalJobValueCents: session.account.typicalJobValueCents,
  };
  const after: AuditableSettings = {
    businessName,
    ownerPhoneNumber: ownerPhone,
    ownerEmail: ownerEmail || null,
    schedulingUrl: schedulingUrl || null,
    smsTemplate: smsTemplate || null,
    quickReplyTemplates: quickReplies.length ? quickReplies : null,
    missedCallVoiceMessage: voiceMessage || null,
    missedCallGreetingAudioUrl: greetingAudioUrl || null,
    dialTimeoutSeconds: dialTimeout,
    voicemailMaxSeconds: voicemailMax,
    missedCallSmsCooldownHours: cooldownHours,
    typicalJobValueCents,
    // Only owners submit the switch; leaving it undefined keeps it out of the diff.
    ...(session.role === "owner" ? { smsEnabled: update.sms_enabled } : {}),
  };

  const auditEvents = diffSettingsForAudit(before, after);

  await recordAccountAuditEvents({
    accountId: session.accountId,
    actorUserId: session.userId,
    actorEmail: session.email,
    events: auditEvents,
  });

  redirect("/settings?saved=1");
}

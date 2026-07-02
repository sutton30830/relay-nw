import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { normalizePhoneNumber } from "@/lib/phone";
import { updateAccountSettings, type AccountSettingsUpdate } from "@/lib/supabase";

const LIMITS = {
  dialTimeoutSeconds: { min: 5, max: 60 },
  voicemailMaxSeconds: { min: 10, max: 300 },
  cooldownHours: { min: 1, max: 168 },
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

export async function POST(request: Request) {
  const session = await requireAccountUser();

  if (session.role === "viewer") {
    redirect("/settings?error=forbidden");
  }

  const formData = await request.formData();

  const businessName = readString(formData, "business_name", 120);
  const ownerPhone = normalizePhoneNumber(readString(formData, "owner_phone_number", 30));
  const ownerEmail = readString(formData, "owner_email", 200).toLowerCase();
  const schedulingUrl = readString(formData, "scheduling_url", 500);
  const smsTemplate = readString(formData, "sms_template", 600);
  const voiceMessage = readString(formData, "missed_call_voice_message", 600);
  const greetingAudioUrl = readString(formData, "missed_call_greeting_audio_url", 500);
  const dialTimeout = readNumber(formData, "dial_timeout_seconds", LIMITS.dialTimeoutSeconds);
  const voicemailMax = readNumber(formData, "voicemail_max_seconds", LIMITS.voicemailMaxSeconds);
  const cooldownHours = readNumber(formData, "missed_call_sms_cooldown_hours", LIMITS.cooldownHours);

  if (!businessName || !ownerPhone || dialTimeout === null || voicemailMax === null || cooldownHours === null) {
    redirect("/settings?error=invalid");
  }

  if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    redirect("/settings?error=invalid");
  }

  if (schedulingUrl && !/^https?:\/\//.test(schedulingUrl)) {
    redirect("/settings?error=invalid");
  }

  if (greetingAudioUrl && !/^https:\/\//.test(greetingAudioUrl)) {
    redirect("/settings?error=invalid");
  }

  const update: AccountSettingsUpdate = {
    business_name: businessName,
    owner_phone_number: ownerPhone,
    owner_email: ownerEmail || null,
    scheduling_url: schedulingUrl || null,
    sms_template: smsTemplate || null,
    missed_call_voice_message: voiceMessage || null,
    missed_call_greeting_audio_url: greetingAudioUrl || null,
    dial_timeout_seconds: dialTimeout,
    voicemail_max_seconds: voicemailMax,
    missed_call_sms_cooldown_hours: cooldownHours,
  };

  // Only the owner can flip texting on/off — it is the compliance-sensitive switch.
  if (session.role === "owner") {
    update.sms_enabled = formData.get("sms_enabled") === "on";
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

  redirect("/settings?saved=1");
}

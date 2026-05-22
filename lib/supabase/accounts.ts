import { env } from "@/lib/env";
import { normalizePhoneNumber } from "@/lib/phone";
import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";

export type AccountRuntimeConfig = {
  accountId: string | null;
  accountSlug: string;
  businessName: string;
  ownerEmail: string | null;
  callMode: "direct" | "forwarding";
  smsEnabled: boolean;
  intakeUrl: string;
  schedulingUrl: string;
  smsTemplate: string | null;
  missedCallVoiceMessage: string | null;
  missedCallVoiceName: string;
  missedCallGreetingAudioUrl: string | null;
  voicemailMaxSeconds: number;
  dialTimeoutSeconds: number;
  missedCallSmsCooldownHours: number;
  voicemailTranscriptionEnabled: boolean;
  twilioPhoneNumber: string;
  ownerPhoneNumber: string;
};

type AccountSettingsRow = {
  account_id: string;
  business_name: string;
  owner_email: string | null;
  owner_phone_number: string;
  intake_url: string;
  scheduling_url: string | null;
  call_mode: "direct" | "forwarding";
  sms_enabled: boolean;
  sms_template: string | null;
  missed_call_voice_message: string | null;
  missed_call_voice_name: string | null;
  missed_call_greeting_audio_url: string | null;
  voicemail_max_seconds: number | null;
  dial_timeout_seconds: number | null;
  missed_call_sms_cooldown_hours: number | null;
  voicemail_transcription_enabled: boolean | null;
  accounts?: { slug: string } | Array<{ slug: string }> | null;
};

const ACCOUNT_SETTINGS_SELECT =
  "account_id, business_name, owner_email, owner_phone_number, intake_url, scheduling_url, call_mode, sms_enabled, sms_template, missed_call_voice_message, missed_call_voice_name, missed_call_greeting_audio_url, voicemail_max_seconds, dial_timeout_seconds, missed_call_sms_cooldown_hours, voicemail_transcription_enabled, accounts(slug)";

export function envAccountConfig(): AccountRuntimeConfig {
  return {
    accountId: null,
    accountSlug: env.defaultAccountSlug,
    businessName: env.businessName,
    ownerEmail: null,
    callMode: env.callMode as "direct" | "forwarding",
    smsEnabled: env.smsEnabled,
    intakeUrl: env.intakeUrl,
    schedulingUrl: env.schedulingUrl,
    smsTemplate: env.smsTemplate ?? null,
    missedCallVoiceMessage: env.missedCallVoiceMessage ?? null,
    missedCallVoiceName: env.missedCallVoiceName,
    missedCallGreetingAudioUrl: env.missedCallGreetingAudioUrl ?? null,
    voicemailMaxSeconds: env.voicemailMaxSeconds,
    dialTimeoutSeconds: env.dialTimeoutSeconds,
    missedCallSmsCooldownHours: env.missedCallSmsCooldownHours,
    voicemailTranscriptionEnabled: true,
    twilioPhoneNumber: normalizePhoneNumber(env.twilioPhoneNumber),
    ownerPhoneNumber: normalizePhoneNumber(env.ownerPhoneNumber),
  };
}

function configFromSettings(row: AccountSettingsRow, primaryNumber: string): AccountRuntimeConfig {
  const account = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;

  return {
    accountId: row.account_id,
    accountSlug: account?.slug ?? env.defaultAccountSlug,
    businessName: row.business_name,
    ownerEmail: row.owner_email,
    callMode: row.call_mode,
    smsEnabled: row.sms_enabled,
    intakeUrl: row.intake_url,
    schedulingUrl: row.scheduling_url ?? env.schedulingUrl,
    smsTemplate: row.sms_template,
    missedCallVoiceMessage: row.missed_call_voice_message,
    missedCallVoiceName: row.missed_call_voice_name ?? "Polly.Joanna-Neural",
    missedCallGreetingAudioUrl: row.missed_call_greeting_audio_url,
    voicemailMaxSeconds: row.voicemail_max_seconds ?? 60,
    dialTimeoutSeconds: row.dial_timeout_seconds ?? 18,
    missedCallSmsCooldownHours: row.missed_call_sms_cooldown_hours ?? 24,
    voicemailTranscriptionEnabled: row.voicemail_transcription_enabled ?? true,
    twilioPhoneNumber: normalizePhoneNumber(primaryNumber),
    ownerPhoneNumber: normalizePhoneNumber(row.owner_phone_number),
  };
}

async function getPrimaryAccountPhoneNumber(accountId: string) {
  const { data, error } = await supabaseAdmin
    .from("account_phone_numbers")
    .select("phone_number, is_primary")
    .eq("account_id", accountId)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (error.message.includes("account_phone_numbers")) {
      return env.twilioPhoneNumber;
    }

    throw error;
  }

  return data?.phone_number ?? env.twilioPhoneNumber;
}

export async function getAccountConfigByAccountId(accountId: string | null | undefined) {
  if (!accountId || isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("account_settings")
    .select(ACCOUNT_SETTINGS_SELECT)
    .eq("account_id", accountId)
    .maybeSingle();

  if (error) {
    if (error.message.includes("account_settings")) {
      console.warn("Account settings table is missing. Run supabase.sql before enabling tenants.");
      return null;
    }

    throw error;
  }

  return data
    ? configFromSettings(
        data as unknown as AccountSettingsRow,
        await getPrimaryAccountPhoneNumber((data as unknown as AccountSettingsRow).account_id),
      )
    : null;
}

export async function getDefaultAccountConfig() {
  if (isPlaceholderSupabaseConfig()) {
    return envAccountConfig();
  }

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id")
    .eq("slug", env.defaultAccountSlug)
    .maybeSingle();

  if (error) {
    if (error.message.includes("accounts")) {
      console.warn("Account tables are missing. Run supabase.sql before enabling tenants.");
      return envAccountConfig();
    }

    throw error;
  }

  return (await getAccountConfigByAccountId(data?.id)) ?? envAccountConfig();
}

export async function resolveAccountByTwilioNumber(phoneNumber: string | null | undefined) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber ?? "");

  if (!normalizedPhone || isPlaceholderSupabaseConfig()) {
    return envAccountConfig();
  }

  const { data, error } = await supabaseAdmin
    .from("account_phone_numbers")
    .select("account_id")
    .eq("phone_number", normalizedPhone)
    .maybeSingle();

  if (error) {
    if (error.message.includes("account_phone_numbers")) {
      console.warn("Account phone number table is missing. Falling back to env account config.");
      return envAccountConfig();
    }

    throw error;
  }

  return (await getAccountConfigByAccountId(data?.account_id)) ?? envAccountConfig();
}

export async function resolveAccountByCallSid(callSid: string | null | undefined) {
  const normalizedCallSid = callSid?.trim();

  if (!normalizedCallSid || isPlaceholderSupabaseConfig()) {
    return envAccountConfig();
  }

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("account_id")
    .eq("call_sid", normalizedCallSid)
    .maybeSingle();

  if (error) {
    if (error.message.includes("calls")) {
      return envAccountConfig();
    }

    throw error;
  }

  return (await getAccountConfigByAccountId(data?.account_id)) ?? envAccountConfig();
}

export async function resolveAccountByMessageSid(messageSid: string | null | undefined) {
  const normalizedMessageSid = messageSid?.trim();

  if (!normalizedMessageSid || isPlaceholderSupabaseConfig()) {
    return envAccountConfig();
  }

  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("account_id")
    .eq("twilio_message_sid", normalizedMessageSid)
    .maybeSingle();

  if (error) {
    if (error.message.includes("messages")) {
      return envAccountConfig();
    }

    throw error;
  }

  return (await getAccountConfigByAccountId(data?.account_id)) ?? envAccountConfig();
}

export async function provisionAccount(input: {
  slug: string;
  businessName: string;
  ownerPhoneNumber: string;
  twilioPhoneNumber: string;
  intakeUrl: string;
  schedulingUrl?: string | null;
  callMode?: "direct" | "forwarding";
  smsEnabled?: boolean;
  ownerEmail?: string | null;
}) {
  if (shouldSkipDatabaseWrite("account provisioning", input)) {
    return null;
  }

  const { data: account, error: accountError } = await supabaseAdmin
    .from("accounts")
    .upsert({
      slug: input.slug,
      name: input.businessName,
      status: "active",
      updated_at: new Date().toISOString(),
    }, { onConflict: "slug" })
    .select("id")
    .single();

  throwIfSupabaseError(accountError);

  const accountId = account!.id as string;

  const { error: settingsError } = await supabaseAdmin
    .from("account_settings")
    .upsert({
      account_id: accountId,
      business_name: input.businessName,
      owner_email: input.ownerEmail?.toLowerCase() ?? null,
      owner_phone_number: normalizePhoneNumber(input.ownerPhoneNumber),
      intake_url: input.intakeUrl,
      scheduling_url: input.schedulingUrl ?? input.intakeUrl,
      call_mode: input.callMode ?? "forwarding",
      sms_enabled: input.smsEnabled ?? false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id" });

  throwIfSupabaseError(settingsError);

  const { error: phoneError } = await supabaseAdmin
    .from("account_phone_numbers")
    .upsert({
      account_id: accountId,
      phone_number: normalizePhoneNumber(input.twilioPhoneNumber),
      label: "Primary Twilio number",
      is_primary: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone_number" });

  throwIfSupabaseError(phoneError);

  return accountId;
}

export async function getOwnerNotificationEmail(accountId: string | null | undefined) {
  if (!accountId || isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data: settings, error: settingsError } = await supabaseAdmin
    .from("account_settings")
    .select("owner_email")
    .eq("account_id", accountId)
    .maybeSingle();

  if (settingsError && !settingsError.message.includes("owner_email")) {
    throw settingsError;
  }

  const ownerEmail = typeof settings?.owner_email === "string"
    ? settings.owner_email.trim().toLowerCase()
    : null;

  if (ownerEmail) {
    return ownerEmail;
  }

  const { data: accountUser, error: userError } = await supabaseAdmin
    .from("account_users")
    .select("email")
    .eq("account_id", accountId)
    .in("role", ["owner", "admin"])
    .not("email", "is", null)
    .order("role", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (userError) {
    throw userError;
  }

  return typeof accountUser?.email === "string"
    ? accountUser.email.trim().toLowerCase()
    : null;
}

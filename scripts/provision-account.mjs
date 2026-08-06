import { createClient } from "@supabase/supabase-js";

const required = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ACCOUNT_SLUG",
  "BUSINESS_NAME",
  "LEGAL_BUSINESS_NAME",
  "OWNER_NAME",
  "OWNER_EMAIL",
  "OWNER_PHONE_NUMBER",
  "TWILIO_PHONE_NUMBER",
  "INTAKE_URL",
  "BUSINESS_HOURS_SUMMARY",
  "COVERAGE_EXPECTATIONS",
  "SMS_TEMPLATE",
];

function env(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function optionalEnv(name, fallback = null) {
  return process.env[name] || fallback;
}

function normalizePhoneNumber(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (value.startsWith("+")) return value;
  return value;
}

for (const name of required) {
  env(name);
}

const callMode = optionalEnv("CALL_MODE", "forwarding");
if (callMode !== "forwarding" && callMode !== "direct") {
  throw new Error("CALL_MODE must be forwarding or direct");
}
if (callMode === "forwarding") {
  env("PUBLIC_BUSINESS_NUMBER");
  env("FORWARDING_CARRIER");
}
if (!optionalEnv("MISSED_CALL_VOICE_MESSAGE") && !optionalEnv("MISSED_CALL_GREETING_AUDIO_URL")) {
  throw new Error("Set MISSED_CALL_VOICE_MESSAGE or MISSED_CALL_GREETING_AUDIO_URL");
}

const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const now = new Date().toISOString();
const slug = env("ACCOUNT_SLUG");
const businessName = env("BUSINESS_NAME");
const smsEnabled = optionalEnv("SMS_ENABLED", "false") === "true";
const a2pRegistrationStatus = optionalEnv("A2P_REGISTRATION_STATUS");
const a2pNotApprovedMessage =
  "Texting can't be enabled until this account's A2P registration is approved. Update the status with the provisioning script first.";

const { data: account, error: accountError } = await supabase
  .from("accounts")
  .upsert({
    slug,
    name: businessName,
    status: "active",
    updated_at: now,
  }, { onConflict: "slug" })
  .select("id")
  .single();

if (accountError) throw accountError;

const accountId = account.id;

if (smsEnabled && a2pRegistrationStatus !== "approved") {
  const { data: existingSettings, error: existingSettingsError } = await supabase
    .from("account_settings")
    .select("a2p_registration_status")
    .eq("account_id", accountId)
    .maybeSingle();

  if (existingSettingsError) throw existingSettingsError;

  if (existingSettings?.a2p_registration_status !== "approved") {
    throw new Error(a2pNotApprovedMessage);
  }
}

const settingsPayload = {
  account_id: accountId,
  business_name: businessName,
  legal_business_name: env("LEGAL_BUSINESS_NAME"),
  owner_name: env("OWNER_NAME"),
  owner_email: env("OWNER_EMAIL").toLowerCase(),
  owner_phone_number: normalizePhoneNumber(env("OWNER_PHONE_NUMBER")),
  public_business_number: callMode === "forwarding"
    ? normalizePhoneNumber(env("PUBLIC_BUSINESS_NUMBER"))
    : null,
  forwarding_carrier: callMode === "forwarding" ? env("FORWARDING_CARRIER") : null,
  business_hours: { summary: env("BUSINESS_HOURS_SUMMARY") },
  coverage_expectations: env("COVERAGE_EXPECTATIONS"),
  intake_url: env("INTAKE_URL"),
  scheduling_url: optionalEnv("SCHEDULING_URL", env("INTAKE_URL")),
  call_mode: callMode,
  sms_enabled: smsEnabled,
  sms_template: env("SMS_TEMPLATE"),
  updated_at: now,
};

if (a2pRegistrationStatus) {
  settingsPayload.a2p_registration_status = a2pRegistrationStatus;
}

const missedCallVoiceMessage = optionalEnv("MISSED_CALL_VOICE_MESSAGE");
if (missedCallVoiceMessage) {
  settingsPayload.missed_call_voice_message = missedCallVoiceMessage;
}

const missedCallGreetingAudioUrl = optionalEnv("MISSED_CALL_GREETING_AUDIO_URL");
if (missedCallGreetingAudioUrl) {
  settingsPayload.missed_call_greeting_audio_url = missedCallGreetingAudioUrl;
}

const { error: settingsError } = await supabase
  .from("account_settings")
  .upsert(settingsPayload, { onConflict: "account_id" });

if (settingsError) throw settingsError;

const { error: phoneError } = await supabase
  .from("account_phone_numbers")
  .upsert({
    account_id: accountId,
    phone_number: normalizePhoneNumber(env("TWILIO_PHONE_NUMBER")),
    label: "Primary Twilio number",
    is_primary: true,
    updated_at: now,
  }, { onConflict: "phone_number" });

if (phoneError) throw phoneError;

const ownerEmail = env("OWNER_EMAIL");
const { error: userError } = await supabase
  .from("account_users")
  .upsert({
    account_id: accountId,
    email: ownerEmail.toLowerCase(),
    role: "owner",
  }, { onConflict: "account_id,email" });

if (userError) throw userError;

console.log(JSON.stringify({
  ok: true,
  accountId,
  slug,
  businessName,
  callMode,
  twilioPhoneNumber: normalizePhoneNumber(env("TWILIO_PHONE_NUMBER")),
  ownerEmail,
  nextAction: "Invite this owner email in Supabase Auth, then complete evidence-backed checks in Operations.",
}, null, 2));

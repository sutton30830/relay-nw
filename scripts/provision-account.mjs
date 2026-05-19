import { createClient } from "@supabase/supabase-js";

const required = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ACCOUNT_SLUG",
  "BUSINESS_NAME",
  "OWNER_PHONE_NUMBER",
  "TWILIO_PHONE_NUMBER",
  "INTAKE_URL",
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

const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const now = new Date().toISOString();
const slug = env("ACCOUNT_SLUG");
const businessName = env("BUSINESS_NAME");

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

const { error: settingsError } = await supabase
  .from("account_settings")
  .upsert({
    account_id: accountId,
    business_name: businessName,
    owner_phone_number: normalizePhoneNumber(env("OWNER_PHONE_NUMBER")),
    intake_url: env("INTAKE_URL"),
    scheduling_url: optionalEnv("SCHEDULING_URL", env("INTAKE_URL")),
    call_mode: optionalEnv("CALL_MODE", "forwarding"),
    sms_enabled: optionalEnv("SMS_ENABLED", "false") === "true",
    missed_call_voice_message: optionalEnv("MISSED_CALL_VOICE_MESSAGE"),
    missed_call_greeting_audio_url: optionalEnv("MISSED_CALL_GREETING_AUDIO_URL"),
    updated_at: now,
  }, { onConflict: "account_id" });

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

console.log(JSON.stringify({
  ok: true,
  accountId,
  slug,
  businessName,
  twilioPhoneNumber: normalizePhoneNumber(env("TWILIO_PHONE_NUMBER")),
}, null, 2));

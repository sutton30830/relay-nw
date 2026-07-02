function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getOptionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

function getOptionalEnvAliases(...names: string[]): string | undefined {
  for (const name of names) {
    const value = getOptionalEnv(name);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function getOptionalBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getOptionalNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid number for environment variable: ${name}`);
  }

  return parsed;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/$/, "");
}

function getCallMode() {
  const value = getOptionalEnv("CALL_MODE") ?? "direct";

  if (value !== "direct" && value !== "forwarding") {
    throw new Error("Invalid CALL_MODE. Use direct or forwarding.");
  }

  return value;
}

function getAllowUnsignedTwilioWebhooks() {
  const value = getOptionalBooleanEnv("ALLOW_UNSIGNED_TWILIO_WEBHOOKS", false);

  if (value && process.env.NODE_ENV === "production") {
    throw new Error("ALLOW_UNSIGNED_TWILIO_WEBHOOKS cannot be enabled in production.");
  }

  return value;
}

export const env = {
  callMode: getCallMode(),
  smsEnabled: getOptionalBooleanEnv("SMS_ENABLED", false),
  businessName: getRequiredEnv("BUSINESS_NAME"),
  intakeUrl: getRequiredEnv("INTAKE_URL"),
  schedulingUrl: getRequiredEnv("SCHEDULING_URL"),
  smsTemplate: getOptionalEnv("SMS_TEMPLATE"),
  missedCallVoiceMessage: getOptionalEnv("MISSED_CALL_VOICE_MESSAGE"),
  missedCallVoiceName: getOptionalEnv("MISSED_CALL_VOICE_NAME") ?? "Polly.Joanna-Neural",
  missedCallGreetingAudioUrl: getOptionalEnv("MISSED_CALL_GREETING_AUDIO_URL"),
  voicemailMaxSeconds: getOptionalNumberEnv("VOICEMAIL_MAX_SECONDS", 60),
  dialTimeoutSeconds: getOptionalNumberEnv("DIAL_TIMEOUT_SECONDS", 18),
  missedCallSmsCooldownHours: getOptionalNumberEnv("MISSED_CALL_SMS_COOLDOWN_HOURS", 24),
  webhookEventRetentionDays: getOptionalNumberEnv("WEBHOOK_EVENT_RETENTION_DAYS", 30),
  inboundMessageRetentionDays: getOptionalNumberEnv("INBOUND_MESSAGE_RETENTION_DAYS", 90),
  openaiApiKey: getOptionalEnvAliases("OPENAI_API_KEY", "OPEN_AI_KEY"),
  openaiTranscriptionModel:
    getOptionalEnvAliases("OPENAI_TRANSCRIPTION_MODEL", "OPEN_AI_TRANSCRIPTION_MODEL") ??
    "whisper-1",
  openaiSummaryModel: getOptionalEnv("OPENAI_SUMMARY_MODEL") ?? "gpt-4o-mini",
  resendApiKey: getOptionalEnv("RESEND_API_KEY"),
  cronSecret: getOptionalEnv("CRON_SECRET"),
  alertFromEmail: getOptionalEnv("ALERT_FROM_EMAIL") ?? "Relay NW <alerts@relay-nw.com>",
  adminAlertEmail: getOptionalEnv("ADMIN_ALERT_EMAIL"),
  defaultAccountSlug: getOptionalEnv("RELAY_DEFAULT_ACCOUNT_SLUG") ?? "relay-nw",
  appBaseUrl: normalizeBaseUrl(getRequiredEnv("APP_BASE_URL")),
  allowUnsignedTwilioWebhooks: getAllowUnsignedTwilioWebhooks(),
  twilioAccountSid: getRequiredEnv("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: getRequiredEnv("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: getRequiredEnv("TWILIO_PHONE_NUMBER"),
  ownerPhoneNumber: getRequiredEnv("OWNER_PHONE_NUMBER"),
  supabaseUrl: getOptionalEnv("SUPABASE_URL") ?? getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: getRequiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
};

// Admin email alerts are the failure-visibility backstop when Supabase itself is
// unreachable (the webhook event log can't record a Supabase outage). Don't fail the
// boot, but make a misconfigured backstop loud in production logs.
if (process.env.NODE_ENV === "production") {
  if (!env.resendApiKey) {
    console.warn(
      "RESEND_API_KEY is not set in production. Admin/owner email alerts are disabled — pipeline failures will only be visible in the webhook event log and server logs.",
    );
  }

  if (!env.adminAlertEmail) {
    console.warn(
      "ADMIN_ALERT_EMAIL is not set in production. Operational failure alerts (SMS send failures, reconciliation issues, transcription failures) have no recipient.",
    );
  }

  if (!process.env.SENTRY_DSN) {
    console.warn(
      "SENTRY_DSN is not set in production. Unhandled errors are only visible in Vercel logs.",
    );
  }
}

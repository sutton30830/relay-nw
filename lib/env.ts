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

export const env = {
  callMode: getCallMode(),
  businessName: getRequiredEnv("BUSINESS_NAME"),
  intakeUrl: getRequiredEnv("INTAKE_URL"),
  schedulingUrl: getRequiredEnv("SCHEDULING_URL"),
  smsTemplate: getOptionalEnv("SMS_TEMPLATE"),
  dialTimeoutSeconds: getOptionalNumberEnv("DIAL_TIMEOUT_SECONDS", 18),
  missedCallSmsCooldownHours: getOptionalNumberEnv("MISSED_CALL_SMS_COOLDOWN_HOURS", 24),
  leadsPassword: getRequiredEnv("LEADS_PASSWORD"),
  leadsCookieSecret: getOptionalEnv("LEADS_COOKIE_SECRET") ?? getRequiredEnv("LEADS_PASSWORD"),
  appBaseUrl: normalizeBaseUrl(getRequiredEnv("APP_BASE_URL")),
  allowUnsignedTwilioWebhooks: getOptionalBooleanEnv("ALLOW_UNSIGNED_TWILIO_WEBHOOKS", false),
  twilioAccountSid: getRequiredEnv("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: getRequiredEnv("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: getRequiredEnv("TWILIO_PHONE_NUMBER"),
  ownerPhoneNumber: getRequiredEnv("OWNER_PHONE_NUMBER"),
  supabaseUrl: getOptionalEnv("SUPABASE_URL") ?? getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseServiceRoleKey: getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
};

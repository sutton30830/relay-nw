function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const env = {
  businessName: getRequiredEnv("BUSINESS_NAME"),
  intakeUrl: getRequiredEnv("INTAKE_URL"),
  schedulingUrl: getRequiredEnv("SCHEDULING_URL"),
  leadsPassword: getRequiredEnv("LEADS_PASSWORD"),
  twilioAccountSid: getRequiredEnv("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: getRequiredEnv("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: getRequiredEnv("TWILIO_PHONE_NUMBER"),
  ownerPhoneNumber: getRequiredEnv("OWNER_PHONE_NUMBER"),
  supabaseUrl: getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseServiceRoleKey: getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
};

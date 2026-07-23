import { env } from "@/lib/env";
import type {
  AccountBillingRecord,
  AccountBillingStatus,
  AccountOnboardingStatus,
  StripeSubscriptionStatus,
} from "@/lib/billing";
import { normalizePhoneNumber } from "@/lib/phone";
import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";

export type AccountRuntimeConfig = {
  accountId: string | null;
  accountSlug: string;
  businessName: string;
  ownerEmail: string | null;
  ownerName: string | null;
  legalBusinessName: string | null;
  publicBusinessNumber: string | null;
  businessType: string | null;
  businessIndustry: string | null;
  websiteUrl: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressCountry: string;
  businessHours: Record<string, unknown> | null;
  implementationNotes: string | null;
  greetingPreference: "generated" | "recorded";
  callMode: "direct" | "forwarding";
  smsEnabled: boolean;
  intakeUrl: string;
  schedulingUrl: string;
  smsTemplate: string | null;
  // Per-account quick-reply templates for the SMS composer. null = the account
  // hasn't customized them, so the UI falls back to the shared defaults.
  quickReplyTemplates: string[] | null;
  missedCallVoiceMessage: string | null;
  missedCallVoiceName: string;
  missedCallGreetingAudioUrl: string | null;
  voicemailMaxSeconds: number;
  dialTimeoutSeconds: number;
  missedCallSmsCooldownHours: number;
  typicalJobValueCents: number | null;
  voicemailTranscriptionEnabled: boolean;
  twilioPhoneNumber: string;
  ownerPhoneNumber: string;
};

export type AccountResolution =
  | { status: "resolved"; account: AccountRuntimeConfig }
  | { status: "unresolved"; reason: string; lookupValue: string | null };

// Webhook routes resolve the tenant before their try/catch blocks. If resolution itself
// throws (e.g. transient Supabase outage), the route would 500 with no TwiML, no webhook
// event, and — on voice — the caller hearing Twilio's error message. Downgrading to
// "unresolved" keeps the webhook visible: the unresolved handler returns 200 TwiML, logs
// a webhook event, and alerts the admin.
export async function resolveAccountSafely(
  resolve: () => Promise<AccountResolution>,
  label: string,
): Promise<AccountResolution> {
  try {
    return await resolve();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown account resolution error";

    console.error("Twilio webhook account resolution threw; treating as unresolved", {
      label,
      error: message,
    });

    return {
      status: "unresolved",
      reason: `account_resolution_error: ${message}`,
      lookupValue: null,
    };
  }
}

type AccountSettingsRow = {
  account_id: string;
  business_name: string;
  owner_email: string | null;
  owner_name?: string | null;
  legal_business_name?: string | null;
  public_business_number?: string | null;
  business_type?: string | null;
  business_industry?: string | null;
  website_url?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  address_city?: string | null;
  address_region?: string | null;
  address_postal_code?: string | null;
  address_country?: string | null;
  business_hours?: Record<string, unknown> | null;
  implementation_notes?: string | null;
  greeting_preference?: string | null;
  owner_phone_number: string;
  intake_url: string;
  scheduling_url: string | null;
  call_mode: "direct" | "forwarding";
  sms_enabled: boolean;
  sms_template: string | null;
  quick_reply_templates: string[] | null;
  missed_call_voice_message: string | null;
  missed_call_voice_name: string | null;
  missed_call_greeting_audio_url: string | null;
  voicemail_max_seconds: number | null;
  dial_timeout_seconds: number | null;
  missed_call_sms_cooldown_hours: number | null;
  typical_job_value_cents?: number | null;
  voicemail_transcription_enabled: boolean | null;
  accounts?: { slug: string } | Array<{ slug: string }> | null;
};

type AccountBillingRow = {
  billing_status: string | null;
  billing_policy: string | null;
  billing_policy_updated_at: string | null;
  onboarding_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  stripe_payment_method_id: string | null;
  stripe_subscription_status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  requirements_due_at: string | null;
  activated_at: string | null;
  first_paid_at: string | null;
  guarantee_ends_at: string | null;
  billing_attention_since: string | null;
  billing_updated_at: string | null;
  canceled_at: string | null;
  onboarding_status_updated_at: string | null;
  setup_fee_cents: number | null;
  setup_fee_status: string | null;
  setup_fee_checkout_session_id: string | null;
  setup_fee_payment_intent_id: string | null;
  setup_fee_paid_at: string | null;
  setup_fee_waived_at: string | null;
  setup_fee_waiver_reason: string | null;
  setup_fee_refunded_at: string | null;
  setup_fee_refunded_cents: number | null;
  setup_fee_dispute_status: string | null;
  monthly_price_cents: number | null;
};

type AccountDurableBillingDates = {
  activated_at: string | null;
  first_paid_at: string | null;
  guarantee_ends_at: string | null;
};

export type StripeEventProcessingStatus = "received" | "processing" | "processed" | "ignored" | "failed";

export type StripeEventClaim =
  | { status: "claimed"; attemptCount: number }
  | { status: "duplicate"; processingStatus: "processed" | "ignored" }
  | { status: "already_processing"; attemptCount: number };

export type StripeEventClaimInput = {
  eventId: string;
  eventType: string;
  eventCreatedAt: string | null;
  livemode: boolean;
  accountId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  staleAfterMs?: number;
};

export type StripeEventMarkInput = {
  eventId: string;
  accountId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
};

export type StripeEventRow = {
  event_id: string;
  event_type: string;
  event_created_at: string | null;
  livemode: boolean;
  account_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  processing_status: StripeEventProcessingStatus;
  attempt_count: number;
  error_code: string | null;
  ignore_reason: string | null;
  processing_started_at: string | null;
  received_at: string;
  processed_at: string | null;
};

export type OnboardingDeadlineAccount = {
  accountId: string;
  accountSlug: string;
  businessName: string;
  ownerEmail: string | null;
  onboardingStatus: AccountOnboardingStatus;
  requirementsDueAt: string | null;
  onboardingStatusUpdatedAt: string | null;
};

export type BillingTrialExpiryAccount = {
  accountId: string;
  accountSlug: string;
  businessName: string;
  ownerEmail: string | null;
  billingStatus: AccountBillingStatus;
  stripeSubscriptionId: string | null;
  trialEndsAt: string | null;
};

export type OpsOnboardingAccount = {
  accountId: string;
  accountSlug: string;
  businessName: string;
  onboardingStatus: AccountOnboardingStatus;
  requirementsDueAt: string | null;
  activatedAt: string | null;
  firstPaidAt: string | null;
  guaranteeEndsAt: string | null;
};

export type OpsBillingAccount = AccountBillingRecord & {
  accountId: string;
  accountSlug: string;
  businessName: string;
};

export type OpsAccountSummary = {
  accountId: string;
  accountSlug: string;
  businessName: string;
  accountStatus: "active" | "paused" | "archived";
  ownerEmail: string | null;
  billingStatus: AccountBillingStatus;
  onboardingStatus: AccountOnboardingStatus;
  stripeSubscriptionStatus: StripeSubscriptionStatus | null;
  requirementsDueAt: string | null;
  activatedAt: string | null;
  firstPaidAt: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  billingUpdatedAt: string | null;
  updatedAt: string | null;
  canceledAt: string | null;
};

const DEFAULT_BILLING_RECORD: AccountBillingRecord = {
  billingStatus: "not_started",
  billingPolicy: "setup_fee_waived",
  onboardingStatus: "requirements_needed",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripePriceId: null,
  stripePaymentMethodId: null,
  stripeSubscriptionStatus: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  requirementsDueAt: null,
  activatedAt: null,
  firstPaidAt: null,
  guaranteeEndsAt: null,
  billingAttentionSince: null,
  billingUpdatedAt: null,
  onboardingStatusUpdatedAt: null,
  setupFeeCents: 15000,
  setupFeeStatus: "waived",
  setupFeeCheckoutSessionId: null,
  setupFeePaymentIntentId: null,
  setupFeePaidAt: null,
  setupFeeWaivedAt: null,
  setupFeeWaiverReason: null,
  setupFeeRefundedAt: null,
  setupFeeRefundedCents: 0,
  setupFeeDisputeStatus: null,
  monthlyPriceCents: 9900,
};

function defaultAccountBillingRecord(): AccountBillingRecord {
  return { ...DEFAULT_BILLING_RECORD };
}

function assertAccountIdForAccountStore(accountId: string | null | undefined, context: string) {
  if (!accountId) {
    throw new Error(`${context} requires an account id`);
  }

  return accountId;
}

function normalizeAccountBillingStatus(value: string | null | undefined): AccountBillingStatus {
  if (
    value === "not_started" ||
    value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "canceled" ||
    value === "comped"
  ) {
    return value;
  }

  return "not_started";
}

function normalizeAccountBillingPolicy(
  value: string | null | undefined,
  billingStatus?: string | null,
  setupFeeStatus?: string | null,
): AccountBillingRecord["billingPolicy"] {
  if (value === "standard" || value === "setup_fee_waived" || value === "comped") return value;
  if (billingStatus === "comped") return "comped";
  if (setupFeeStatus === "waived") return "setup_fee_waived";
  return "standard";
}

function normalizeAccountOnboardingStatus(value: string | null | undefined): AccountOnboardingStatus {
  if (
    value === "requirements_needed" ||
    value === "waiting_on_customer" ||
    value === "ready_for_carrier" ||
    value === "carrier_review" ||
    value === "carrier_attention" ||
    value === "ready_for_live_test" ||
    value === "ready_to_activate" ||
    value === "activated" ||
    value === "paused_incomplete" ||
    value === "closed_incomplete"
  ) {
    return value;
  }

  return "requirements_needed";
}

function normalizeAccountStripeSubscriptionStatus(value: string | null | undefined): StripeSubscriptionStatus | null {
  if (
    value === "incomplete" ||
    value === "incomplete_expired" ||
    value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "canceled" ||
    value === "unpaid" ||
    value === "paused"
  ) {
    return value;
  }

  return null;
}

function normalizeSetupFeeStatus(value: string | null | undefined): AccountBillingRecord["setupFeeStatus"] {
  if (
    value === "due" || value === "paid" || value === "waived" ||
    value === "partially_refunded" || value === "refunded" ||
    value === "disputed" || value === "charged_back"
  ) return value;
  return "waived";
}

const ACCOUNT_SETTINGS_SELECT =
  "account_id, business_name, owner_email, owner_name, legal_business_name, public_business_number, business_type, business_industry, website_url, address_line_1, address_line_2, address_city, address_region, address_postal_code, address_country, business_hours, implementation_notes, greeting_preference, owner_phone_number, intake_url, scheduling_url, call_mode, sms_enabled, sms_template, quick_reply_templates, missed_call_voice_message, missed_call_voice_name, missed_call_greeting_audio_url, voicemail_max_seconds, dial_timeout_seconds, missed_call_sms_cooldown_hours, typical_job_value_cents, voicemail_transcription_enabled, accounts(slug)";
const ACCOUNT_SETTINGS_SELECT_PRE_PROFILE =
  "account_id, business_name, owner_email, owner_phone_number, intake_url, scheduling_url, call_mode, sms_enabled, sms_template, quick_reply_templates, missed_call_voice_message, missed_call_voice_name, missed_call_greeting_audio_url, voicemail_max_seconds, dial_timeout_seconds, missed_call_sms_cooldown_hours, typical_job_value_cents, voicemail_transcription_enabled, accounts(slug)";
// Same columns minus quick_reply_templates, for a deploy that lands before the
// supabase.sql migration adds the column. Account config is on every request's
// critical path, so a missing optional column must degrade, not throw.
const ACCOUNT_SETTINGS_SELECT_LEGACY =
  "account_id, business_name, owner_email, owner_phone_number, intake_url, scheduling_url, call_mode, sms_enabled, sms_template, missed_call_voice_message, missed_call_voice_name, missed_call_greeting_audio_url, voicemail_max_seconds, dial_timeout_seconds, missed_call_sms_cooldown_hours, voicemail_transcription_enabled, accounts(slug)";
const ACCOUNT_SETTINGS_SELECT_PRE_TYPICAL_VALUE =
  "account_id, business_name, owner_email, owner_phone_number, intake_url, scheduling_url, call_mode, sms_enabled, sms_template, quick_reply_templates, missed_call_voice_message, missed_call_voice_name, missed_call_greeting_audio_url, voicemail_max_seconds, dial_timeout_seconds, missed_call_sms_cooldown_hours, voicemail_transcription_enabled, accounts(slug)";

export function envAccountConfig(): AccountRuntimeConfig {
  return {
    accountId: null,
    accountSlug: env.defaultAccountSlug,
    businessName: env.businessName,
    ownerEmail: null,
    ownerName: null,
    legalBusinessName: null,
    publicBusinessNumber: null,
    businessType: null,
    businessIndustry: null,
    websiteUrl: null,
    addressLine1: null,
    addressLine2: null,
    addressCity: null,
    addressRegion: null,
    addressPostalCode: null,
    addressCountry: "US",
    businessHours: null,
    implementationNotes: null,
    greetingPreference: "generated",
    callMode: env.callMode as "direct" | "forwarding",
    smsEnabled: env.smsEnabled,
    intakeUrl: env.intakeUrl,
    schedulingUrl: env.schedulingUrl,
    smsTemplate: env.smsTemplate ?? null,
    quickReplyTemplates: null,
    missedCallVoiceMessage: env.missedCallVoiceMessage ?? null,
    missedCallVoiceName: env.missedCallVoiceName,
    missedCallGreetingAudioUrl: env.missedCallGreetingAudioUrl ?? null,
    voicemailMaxSeconds: env.voicemailMaxSeconds,
    dialTimeoutSeconds: env.dialTimeoutSeconds,
    missedCallSmsCooldownHours: env.missedCallSmsCooldownHours,
    typicalJobValueCents: null,
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
    ownerName: row.owner_name ?? null,
    legalBusinessName: row.legal_business_name ?? null,
    publicBusinessNumber: row.public_business_number ?? null,
    businessType: row.business_type ?? null,
    businessIndustry: row.business_industry ?? null,
    websiteUrl: row.website_url ?? null,
    addressLine1: row.address_line_1 ?? null,
    addressLine2: row.address_line_2 ?? null,
    addressCity: row.address_city ?? null,
    addressRegion: row.address_region ?? null,
    addressPostalCode: row.address_postal_code ?? null,
    addressCountry: row.address_country ?? "US",
    businessHours: row.business_hours ?? null,
    implementationNotes: row.implementation_notes ?? null,
    greetingPreference: row.greeting_preference === "recorded" ? "recorded" : "generated",
    callMode: row.call_mode,
    smsEnabled: row.sms_enabled,
    intakeUrl: row.intake_url,
    schedulingUrl: row.scheduling_url ?? env.schedulingUrl,
    smsTemplate: row.sms_template,
    quickReplyTemplates: row.quick_reply_templates ?? null,
    missedCallVoiceMessage: row.missed_call_voice_message,
    missedCallVoiceName: row.missed_call_voice_name ?? "Polly.Joanna-Neural",
    missedCallGreetingAudioUrl: row.missed_call_greeting_audio_url,
    voicemailMaxSeconds: row.voicemail_max_seconds ?? 60,
    dialTimeoutSeconds: row.dial_timeout_seconds ?? 18,
    missedCallSmsCooldownHours: row.missed_call_sms_cooldown_hours ?? 24,
    typicalJobValueCents: row.typical_job_value_cents ?? null,
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

  return data?.phone_number ?? "";
}

export async function assignPrimaryAccountPhoneNumber(input: {
  accountId: string;
  phoneNumber: string;
  twilioSid: string;
  label?: string;
}) {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  const cleared = await supabaseAdmin.from("account_phone_numbers").update({ is_primary: false, updated_at: new Date().toISOString() }).eq("account_id", input.accountId).eq("is_primary", true);
  if (cleared.error) throw cleared.error;
  const { error } = await supabaseAdmin.from("account_phone_numbers").upsert({
    account_id: input.accountId,
    phone_number: phoneNumber,
    twilio_sid: input.twilioSid,
    label: input.label ?? "Primary Relay number",
    is_primary: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: "phone_number" });
  if (error) throw error;
}

export async function getAccountConfigByAccountId(accountId: string | null | undefined) {
  if (!accountId || isPlaceholderSupabaseConfig()) {
    return null;
  }

  const [settingsResult, primaryNumber] = await Promise.all([
    supabaseAdmin
      .from("account_settings")
      .select(ACCOUNT_SETTINGS_SELECT)
      .eq("account_id", accountId)
      .maybeSingle(),
    getPrimaryAccountPhoneNumber(accountId),
  ]);

  let { data, error } = settingsResult;

  if (error && /owner_name|legal_business_name|public_business_number|business_type|business_industry|website_url|address_|business_hours|implementation_notes|greeting_preference/.test(error.message)) {
    console.warn("Extended customer profile columns are missing. Run supabase.sql to enable guided onboarding.");
    ({ data, error } = await supabaseAdmin
      .from("account_settings")
      .select(ACCOUNT_SETTINGS_SELECT_PRE_PROFILE)
      .eq("account_id", accountId)
      .maybeSingle());
  }

  if (error?.message.includes("quick_reply_templates")) {
    console.warn("account_settings.quick_reply_templates is missing. Run supabase.sql to enable editable quick replies.");
    ({ data, error } = await supabaseAdmin
      .from("account_settings")
      .select(ACCOUNT_SETTINGS_SELECT_LEGACY)
      .eq("account_id", accountId)
      .maybeSingle());
  }

  if (error?.message.includes("typical_job_value_cents")) {
    console.warn("account_settings.typical_job_value_cents is missing. Run supabase.sql to enable report estimates.");
    ({ data, error } = await supabaseAdmin
      .from("account_settings")
      .select(ACCOUNT_SETTINGS_SELECT_PRE_TYPICAL_VALUE)
      .eq("account_id", accountId)
      .maybeSingle());
  }

  if (error) {
    if (error.message.includes("account_settings")) {
      console.warn("Account settings table is missing. Run supabase.sql before enabling tenants.");
      return null;
    }

    throw error;
  }

  return data ? configFromSettings(data as unknown as AccountSettingsRow, primaryNumber) : null;
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

export async function getAccountBillingRecord(accountId: string | null | undefined): Promise<AccountBillingRecord> {
  if (!accountId || isPlaceholderSupabaseConfig()) {
    return defaultAccountBillingRecord();
  }

  let { data, error } = await supabaseAdmin
    .from("accounts")
    .select(
      "billing_status, billing_policy, billing_policy_updated_at, onboarding_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_payment_method_id, stripe_subscription_status, trial_ends_at, current_period_end, cancel_at_period_end, requirements_due_at, activated_at, first_paid_at, guarantee_ends_at, billing_attention_since, billing_updated_at, canceled_at, onboarding_status_updated_at, setup_fee_cents, setup_fee_status, setup_fee_checkout_session_id, setup_fee_payment_intent_id, setup_fee_paid_at, setup_fee_waived_at, setup_fee_waiver_reason, setup_fee_refunded_at, setup_fee_refunded_cents, setup_fee_dispute_status, monthly_price_cents",
    )
    .eq("id", accountId)
    .maybeSingle();

  if (error?.message.includes("billing_policy")) {
    console.warn("accounts.billing_policy is missing. Apply the Phase 1 Stripe-authority migration.");
    ({ data, error } = await supabaseAdmin
      .from("accounts")
      .select(
        "billing_status, onboarding_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_payment_method_id, stripe_subscription_status, trial_ends_at, current_period_end, cancel_at_period_end, requirements_due_at, activated_at, first_paid_at, guarantee_ends_at, billing_attention_since, billing_updated_at, canceled_at, onboarding_status_updated_at, setup_fee_cents, setup_fee_status, setup_fee_checkout_session_id, setup_fee_payment_intent_id, setup_fee_paid_at, setup_fee_waived_at, setup_fee_waiver_reason, setup_fee_refunded_at, setup_fee_refunded_cents, setup_fee_dispute_status, monthly_price_cents",
      )
      .eq("id", accountId)
      .maybeSingle());
  }

  if (error) {
    if (
      error.message.includes("billing_status") ||
      error.message.includes("onboarding_status") ||
      error.message.includes("stripe_customer_id") ||
      error.message.includes("stripe_subscription_id") ||
      error.message.includes("stripe_subscription_status") ||
      error.message.includes("current_period_end") ||
      error.message.includes("activated_at") ||
      error.message.includes("setup_fee_status")
    ) {
      console.warn("Account billing lifecycle columns are missing. Run supabase.sql before enabling billing.");
      return defaultAccountBillingRecord();
    }

    throw error;
  }

  const row = data as AccountBillingRow | null;
  if (!row) {
    return defaultAccountBillingRecord();
  }

  return {
    billingStatus: normalizeAccountBillingStatus(row.billing_status),
    billingPolicy: normalizeAccountBillingPolicy(row.billing_policy, row.billing_status, row.setup_fee_status),
    onboardingStatus: normalizeAccountOnboardingStatus(row.onboarding_status),
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
    stripePaymentMethodId: row.stripe_payment_method_id,
    stripeSubscriptionStatus: normalizeAccountStripeSubscriptionStatus(row.stripe_subscription_status),
    trialEndsAt: row.trial_ends_at,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    requirementsDueAt: row.requirements_due_at,
    activatedAt: row.activated_at,
    firstPaidAt: row.first_paid_at,
    guaranteeEndsAt: row.guarantee_ends_at,
    billingAttentionSince: row.billing_attention_since,
    billingUpdatedAt: row.billing_updated_at,
    canceledAt: row.canceled_at,
    onboardingStatusUpdatedAt: row.onboarding_status_updated_at,
    setupFeeCents: Number(row.setup_fee_cents ?? 15000),
    setupFeeStatus: normalizeSetupFeeStatus(row.setup_fee_status),
    setupFeeCheckoutSessionId: row.setup_fee_checkout_session_id,
    setupFeePaymentIntentId: row.setup_fee_payment_intent_id,
    setupFeePaidAt: row.setup_fee_paid_at,
    setupFeeWaivedAt: row.setup_fee_waived_at,
    setupFeeWaiverReason: row.setup_fee_waiver_reason,
    setupFeeRefundedAt: row.setup_fee_refunded_at,
    setupFeeRefundedCents: Number(row.setup_fee_refunded_cents ?? 0),
    setupFeeDisputeStatus: row.setup_fee_dispute_status,
    monthlyPriceCents: Number(row.monthly_price_cents ?? 9900),
  };
}

export async function updateAccountBillingRecord(
  accountId: string,
  update: Partial<AccountBillingRecord>,
) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  const payload: Record<string, string | number | boolean | null> = {
    billing_updated_at: new Date().toISOString(),
  };
  const writesDurableDates =
    update.activatedAt !== undefined ||
    update.firstPaidAt !== undefined ||
    update.guaranteeEndsAt !== undefined;
  let durableDates:
    | AccountDurableBillingDates
    | null = null;

  if (writesDurableDates) {
    const { data, error } = await supabaseAdmin
      .from("accounts")
      .select("activated_at, first_paid_at, guarantee_ends_at")
      .eq("id", accountId)
      .maybeSingle();

    if (error) {
      if (
        error.message.includes("activated_at") ||
        error.message.includes("first_paid_at") ||
        error.message.includes("guarantee_ends_at")
      ) {
        console.warn("Account billing lifecycle columns are missing. Skipping durable lifecycle date updates.");
      } else {
        throwIfSupabaseError(error);
      }
    } else {
      durableDates = data as AccountDurableBillingDates | null;
    }
  }

  if (update.billingStatus !== undefined) payload.billing_status = update.billingStatus;
  if (update.billingPolicy !== undefined) {
    payload.billing_policy = update.billingPolicy;
    payload.billing_policy_updated_at = new Date().toISOString();
  }
  if (update.onboardingStatus !== undefined) {
    payload.onboarding_status = update.onboardingStatus;
    payload.onboarding_status_updated_at = new Date().toISOString();
  }
  if (update.stripeCustomerId !== undefined) payload.stripe_customer_id = update.stripeCustomerId;
  if (update.stripeSubscriptionId !== undefined) payload.stripe_subscription_id = update.stripeSubscriptionId;
  if (update.stripePriceId !== undefined) payload.stripe_price_id = update.stripePriceId;
  if (update.stripePaymentMethodId !== undefined) payload.stripe_payment_method_id = update.stripePaymentMethodId;
  if (update.stripeSubscriptionStatus !== undefined) payload.stripe_subscription_status = update.stripeSubscriptionStatus;
  if (update.trialEndsAt !== undefined) payload.trial_ends_at = update.trialEndsAt;
  if (update.currentPeriodEnd !== undefined) payload.current_period_end = update.currentPeriodEnd;
  if (update.cancelAtPeriodEnd !== undefined) payload.cancel_at_period_end = update.cancelAtPeriodEnd;
  if (update.requirementsDueAt !== undefined) payload.requirements_due_at = update.requirementsDueAt;
  // These dates are lifecycle facts, not current subscription settings. Once
  // written, cancellation, restart, or SMS pause must not reset them.
  if (update.activatedAt !== undefined && !durableDates?.activated_at && update.activatedAt) {
    payload.activated_at = update.activatedAt;
  }
  if (update.firstPaidAt !== undefined && !durableDates?.first_paid_at && update.firstPaidAt) {
    payload.first_paid_at = update.firstPaidAt;
  }
  if (update.guaranteeEndsAt !== undefined && !durableDates?.guarantee_ends_at && update.guaranteeEndsAt) {
    payload.guarantee_ends_at = update.guaranteeEndsAt;
  }
  if (update.billingAttentionSince !== undefined) payload.billing_attention_since = update.billingAttentionSince;
  if (update.canceledAt !== undefined) payload.canceled_at = update.canceledAt;
  if (update.setupFeeCents !== undefined) payload.setup_fee_cents = update.setupFeeCents;
  if (update.setupFeeStatus !== undefined) payload.setup_fee_status = update.setupFeeStatus;
  if (update.setupFeeCheckoutSessionId !== undefined) payload.setup_fee_checkout_session_id = update.setupFeeCheckoutSessionId;
  if (update.setupFeePaymentIntentId !== undefined) payload.setup_fee_payment_intent_id = update.setupFeePaymentIntentId;
  if (update.setupFeePaidAt !== undefined) payload.setup_fee_paid_at = update.setupFeePaidAt;
  if (update.setupFeeWaivedAt !== undefined) payload.setup_fee_waived_at = update.setupFeeWaivedAt;
  if (update.setupFeeWaiverReason !== undefined) payload.setup_fee_waiver_reason = update.setupFeeWaiverReason;
  if (update.setupFeeRefundedAt !== undefined) payload.setup_fee_refunded_at = update.setupFeeRefundedAt;
  if (update.setupFeeRefundedCents !== undefined) payload.setup_fee_refunded_cents = update.setupFeeRefundedCents;
  if (update.setupFeeDisputeStatus !== undefined) payload.setup_fee_dispute_status = update.setupFeeDisputeStatus;
  if (update.monthlyPriceCents !== undefined) payload.monthly_price_cents = update.monthlyPriceCents;

  const { error } = await supabaseAdmin
    .from("accounts")
    .update(payload)
    .eq("id", accountId);

  if (error) {
    throwIfSupabaseError(error);
  }
}

function sanitizeStripeEventText(value: string | null | undefined) {
  return (value ?? "unknown")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120);
}

function stripeEventPayload(input: StripeEventClaimInput | StripeEventMarkInput) {
  const payload: Record<string, string | boolean | number | null> = {};

  if ("accountId" in input) payload.account_id = input.accountId ?? null;
  if ("stripeCustomerId" in input) payload.stripe_customer_id = input.stripeCustomerId ?? null;
  if ("stripeSubscriptionId" in input) payload.stripe_subscription_id = input.stripeSubscriptionId ?? null;

  return payload;
}

export async function resolveAccountIdByStripeSubscriptionId(
  stripeSubscriptionId: string | null | undefined,
): Promise<string | null> {
  if (!stripeSubscriptionId || isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();

  if (error) {
    throwIfSupabaseError(error);
  }

  return typeof data?.id === "string" ? data.id : null;
}

export async function resolveAccountIdByStripeCustomerId(
  stripeCustomerId: string | null | undefined,
): Promise<string | null> {
  if (!stripeCustomerId || isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();

  if (error) {
    throwIfSupabaseError(error);
  }

  return typeof data?.id === "string" ? data.id : null;
}

export async function resolveAccountIdBySetupFeePaymentIntentId(
  paymentIntentId: string | null | undefined,
): Promise<string | null> {
  if (!paymentIntentId || isPlaceholderSupabaseConfig()) return null;
  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id")
    .eq("setup_fee_payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) throwIfSupabaseError(error);
  return typeof data?.id === "string" ? data.id : null;
}

export async function accountExists(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId || isPlaceholderSupabaseConfig()) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id")
    .eq("id", accountId)
    .maybeSingle();

  if (error) {
    throwIfSupabaseError(error);
  }

  return data?.id === accountId;
}

export async function claimStripeEvent(input: StripeEventClaimInput): Promise<StripeEventClaim> {
  if (isPlaceholderSupabaseConfig()) {
    return { status: "claimed", attemptCount: 1 };
  }

  const nowIso = new Date().toISOString();
  const staleAfterMs = input.staleAfterMs ?? 10 * 60 * 1000;
  const staleBeforeIso = new Date(Date.now() - staleAfterMs).toISOString();
  const basePayload = {
    event_id: input.eventId,
    event_type: input.eventType,
    event_created_at: input.eventCreatedAt,
    livemode: input.livemode,
    processing_status: "processing",
    processing_started_at: nowIso,
    attempt_count: 1,
    error_code: null,
    ignore_reason: null,
    ...stripeEventPayload(input),
  };

  const inserted = await supabaseAdmin
    .from("stripe_events")
    .insert(basePayload)
    .select("event_id, attempt_count")
    .single();

  if (!inserted.error) {
    return { status: "claimed", attemptCount: 1 };
  }

  const { data: existing, error: selectError } = await supabaseAdmin
    .from("stripe_events")
    .select("processing_status, attempt_count, processing_started_at")
    .eq("event_id", input.eventId)
    .maybeSingle();

  if (selectError) {
    throwIfSupabaseError(selectError);
  }

  const status = existing?.processing_status as StripeEventProcessingStatus | undefined;

  if (status === "processed" || status === "ignored") {
    return { status: "duplicate", processingStatus: status };
  }

  const attemptCount = typeof existing?.attempt_count === "number" ? existing.attempt_count : 0;
  const processingStartedAt =
    typeof existing?.processing_started_at === "string" ? existing.processing_started_at : null;
  const isStaleProcessing =
    status === "processing" && (!processingStartedAt || processingStartedAt < staleBeforeIso);

  if (status === "processing" && !isStaleProcessing) {
    return { status: "already_processing", attemptCount };
  }

  const reclaimed = await supabaseAdmin
    .from("stripe_events")
    .update({
      event_type: input.eventType,
      event_created_at: input.eventCreatedAt,
      livemode: input.livemode,
      processing_status: "processing",
      processing_started_at: nowIso,
      attempt_count: attemptCount + 1,
      error_code: null,
      ignore_reason: null,
      processed_at: null,
      ...stripeEventPayload(input),
    })
    .eq("event_id", input.eventId)
    .or(`processing_status.in.(received,failed),and(processing_status.eq.processing,processing_started_at.lt.${staleBeforeIso})`)
    .select("attempt_count")
    .maybeSingle();

  if (reclaimed.error) {
    throwIfSupabaseError(reclaimed.error);
  }

  if (!reclaimed.data) {
    return { status: "already_processing", attemptCount };
  }

  return {
    status: "claimed",
    attemptCount: typeof reclaimed.data.attempt_count === "number" ? reclaimed.data.attempt_count : attemptCount + 1,
  };
}

export async function markStripeEventProcessed(input: StripeEventMarkInput) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("stripe_events")
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
      error_code: null,
      ignore_reason: null,
      ...stripeEventPayload(input),
    })
    .eq("event_id", input.eventId);

  if (error) {
    throwIfSupabaseError(error);
  }
}

export async function markStripeEventIgnored(input: StripeEventMarkInput & { reason: string }) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("stripe_events")
    .update({
      processing_status: "ignored",
      processed_at: new Date().toISOString(),
      error_code: null,
      ignore_reason: sanitizeStripeEventText(input.reason),
      ...stripeEventPayload(input),
    })
    .eq("event_id", input.eventId);

  if (error) {
    throwIfSupabaseError(error);
  }
}

export async function markStripeEventFailed(input: StripeEventMarkInput & { errorCode: string }) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("stripe_events")
    .update({
      processing_status: "failed",
      processed_at: null,
      error_code: sanitizeStripeEventText(input.errorCode),
      ...stripeEventPayload(input),
    })
    .eq("event_id", input.eventId);

  if (error) {
    throwIfSupabaseError(error);
  }
}

export async function getRecentStripeEventsForAccount(inputAccountId: string, limit = 25): Promise<StripeEventRow[]> {
  const accountId = assertAccountIdForAccountStore(inputAccountId, "getRecentStripeEventsForAccount");

  if (isPlaceholderSupabaseConfig()) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("stripe_events")
    .select(
      "event_id, event_type, event_created_at, livemode, account_id, stripe_customer_id, stripe_subscription_id, processing_status, attempt_count, error_code, ignore_reason, processing_started_at, received_at, processed_at",
    )
    .eq("account_id", accountId)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (error.message.includes("stripe_events")) {
      console.warn("Stripe events table is missing. Run supabase.sql before enabling billing ops.");
      return [];
    }

    throwIfSupabaseError(error);
  }

  return (data ?? []) as StripeEventRow[];
}

export async function listAccountsForOnboardingDeadlineMaintenance(): Promise<OnboardingDeadlineAccount[]> {
  if (isPlaceholderSupabaseConfig()) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id, slug, name, onboarding_status, requirements_due_at, onboarding_status_updated_at, account_settings(owner_email, business_name)")
    .in("onboarding_status", ["waiting_on_customer", "paused_incomplete"])
    .not("requirements_due_at", "is", null)
    .order("requirements_due_at", { ascending: true })
    .limit(250);

  if (error) {
    if (
      error.message.includes("onboarding_status") ||
      error.message.includes("requirements_due_at") ||
      error.message.includes("account_settings")
    ) {
      console.warn("Account onboarding lifecycle columns are missing. Run supabase.sql before enabling deadline maintenance.");
      return [];
    }

    throwIfSupabaseError(error);
  }

  return (data ?? []).map((row: Record<string, unknown>) => {
    const settingsRaw = row.account_settings;
    const settings = Array.isArray(settingsRaw) ? settingsRaw[0] : settingsRaw;
    const settingsRecord = settings && typeof settings === "object" ? settings as Record<string, unknown> : null;

    return {
      accountId: String(row.id),
      accountSlug: String(row.slug),
      businessName:
        typeof settingsRecord?.business_name === "string" && settingsRecord.business_name.trim()
          ? settingsRecord.business_name
          : String(row.name),
      ownerEmail:
        typeof settingsRecord?.owner_email === "string" && settingsRecord.owner_email.trim()
          ? settingsRecord.owner_email
          : null,
      onboardingStatus: normalizeAccountOnboardingStatus(row.onboarding_status as string | null | undefined),
      requirementsDueAt: typeof row.requirements_due_at === "string" ? row.requirements_due_at : null,
      onboardingStatusUpdatedAt:
        typeof row.onboarding_status_updated_at === "string" ? row.onboarding_status_updated_at : null,
    };
  });
}

export async function listAccountsForBillingTrialExpiry(nowIso = new Date().toISOString()): Promise<BillingTrialExpiryAccount[]> {
  if (isPlaceholderSupabaseConfig()) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id, slug, name, billing_status, stripe_subscription_id, trial_ends_at, account_settings(owner_email, business_name)")
    .eq("billing_status", "trialing")
    .is("stripe_subscription_id", null)
    .not("trial_ends_at", "is", null)
    .lte("trial_ends_at", nowIso)
    .order("trial_ends_at", { ascending: true })
    .limit(250);

  if (error) {
    if (
      error.message.includes("billing_status") ||
      error.message.includes("stripe_subscription_id") ||
      error.message.includes("trial_ends_at") ||
      error.message.includes("account_settings")
    ) {
      console.warn("Account billing lifecycle columns are missing. Run supabase.sql before enabling trial expiry maintenance.");
      return [];
    }

    throwIfSupabaseError(error);
  }

  return (data ?? []).map((row: Record<string, unknown>) => {
    const settingsRaw = row.account_settings;
    const settings = Array.isArray(settingsRaw) ? settingsRaw[0] : settingsRaw;
    const settingsRecord = settings && typeof settings === "object" ? settings as Record<string, unknown> : null;

    return {
      accountId: String(row.id),
      accountSlug: String(row.slug),
      businessName:
        typeof settingsRecord?.business_name === "string" && settingsRecord.business_name.trim()
          ? settingsRecord.business_name
          : String(row.name),
      ownerEmail:
        typeof settingsRecord?.owner_email === "string" && settingsRecord.owner_email.trim()
          ? settingsRecord.owner_email
          : null,
      billingStatus: normalizeAccountBillingStatus(row.billing_status as string | null | undefined),
      stripeSubscriptionId:
        typeof row.stripe_subscription_id === "string" && row.stripe_subscription_id.trim()
          ? row.stripe_subscription_id
          : null,
      trialEndsAt: typeof row.trial_ends_at === "string" ? row.trial_ends_at : null,
    };
  });
}

export async function hasAccountAuditAction(accountId: string, action: string): Promise<boolean> {
  const assertedAccountId = assertAccountIdForAccountStore(accountId, "hasAccountAuditAction");

  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("account_audit_events")
    .select("id")
    .eq("account_id", assertedAccountId)
    .eq("action", action)
    .limit(1)
    .maybeSingle();

  if (error) {
    if (error.message.includes("account_audit_events")) {
      console.warn("Account audit events table is missing. Onboarding deadline reminders may repeat until supabase.sql is applied.");
      return false;
    }

    throwIfSupabaseError(error);
  }

  return Boolean(data?.id);
}

function mapOpsAccountSummary(row: Record<string, unknown>): OpsAccountSummary {
  const settingsRaw = row.account_settings;
  const settings = Array.isArray(settingsRaw) ? settingsRaw[0] : settingsRaw;
  const settingsRecord = settings && typeof settings === "object" ? settings as Record<string, unknown> : null;
  const businessName =
    typeof settingsRecord?.business_name === "string" && settingsRecord.business_name.trim()
      ? settingsRecord.business_name
      : String(row.name ?? row.slug);
  const ownerEmail =
    typeof settingsRecord?.owner_email === "string" && settingsRecord.owner_email.trim()
      ? settingsRecord.owner_email
      : null;

  return {
    accountId: String(row.id),
    accountSlug: String(row.slug),
    businessName,
    accountStatus: row.status === "paused" || row.status === "archived" ? row.status : "active",
    ownerEmail,
    billingStatus: normalizeAccountBillingStatus(row.billing_status as string | null | undefined),
    onboardingStatus: normalizeAccountOnboardingStatus(row.onboarding_status as string | null | undefined),
    stripeSubscriptionStatus: normalizeAccountStripeSubscriptionStatus(
      row.stripe_subscription_status as string | null | undefined,
    ),
    requirementsDueAt: typeof row.requirements_due_at === "string" ? row.requirements_due_at : null,
    activatedAt: typeof row.activated_at === "string" ? row.activated_at : null,
    firstPaidAt: typeof row.first_paid_at === "string" ? row.first_paid_at : null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    currentPeriodEnd: typeof row.current_period_end === "string" ? row.current_period_end : null,
    billingUpdatedAt: typeof row.billing_updated_at === "string" ? row.billing_updated_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    canceledAt: typeof row.canceled_at === "string" ? row.canceled_at : null,
  };
}

export async function listOpsAccounts(query = ""): Promise<OpsAccountSummary[]> {
  if (isPlaceholderSupabaseConfig()) return [];

  const normalizedQuery = query.trim();
  let request = supabaseAdmin
    .from("accounts")
    .select(
      "id, slug, name, status, billing_status, onboarding_status, stripe_subscription_status, requirements_due_at, activated_at, first_paid_at, cancel_at_period_end, current_period_end, billing_updated_at, updated_at, canceled_at, account_settings(owner_email, business_name)",
    )
    .order("updated_at", { ascending: false })
    .limit(250);

  if (normalizedQuery) {
    const escaped = normalizedQuery.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll(",", "\\,");
    request = request.or(`slug.ilike.%${escaped}%,name.ilike.%${escaped}%`);
  }

  const { data, error } = await request;
  if (error) {
    if (error.message.includes("account_settings") || error.message.includes("onboarding_status")) {
      console.warn("Account lifecycle columns are missing. Run supabase.sql before enabling the Operations directory.");
      return [];
    }

    throwIfSupabaseError(error);
  }

  return (data ?? []).map((row) => mapOpsAccountSummary(row as Record<string, unknown>));
}

export async function getOpsAccountBySlug(slug: string): Promise<OpsAccountSummary | null> {
  const normalizedSlug = slug.trim();
  if (!normalizedSlug || isPlaceholderSupabaseConfig()) return null;

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select(
      "id, slug, name, status, billing_status, onboarding_status, stripe_subscription_status, requirements_due_at, activated_at, first_paid_at, cancel_at_period_end, current_period_end, billing_updated_at, updated_at, canceled_at, account_settings(owner_email, business_name)",
    )
    .eq("slug", normalizedSlug)
    .maybeSingle();

  if (error) {
    if (error.message.includes("account_settings") || error.message.includes("onboarding_status")) {
      console.warn("Account lifecycle columns are missing. Run supabase.sql before enabling the Operations directory.");
      return null;
    }

    throwIfSupabaseError(error);
  }

  return data ? mapOpsAccountSummary(data as Record<string, unknown>) : null;
}

export async function getOpsOnboardingAccountBySlug(slug: string): Promise<OpsOnboardingAccount | null> {
  const normalizedSlug = slug.trim();
  if (!normalizedSlug || isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id, slug, name, onboarding_status, requirements_due_at, activated_at, first_paid_at, guarantee_ends_at")
    .eq("slug", normalizedSlug)
    .maybeSingle();

  if (error) {
    if (
      error.message.includes("onboarding_status") ||
      error.message.includes("requirements_due_at")
    ) {
      console.warn("Account onboarding lifecycle columns are missing. Run supabase.sql before using operator onboarding controls.");
      return null;
    }

    throwIfSupabaseError(error);
  }

  if (!data) return null;

  return {
    accountId: String(data.id),
    accountSlug: String(data.slug),
    businessName: String(data.name),
    onboardingStatus: normalizeAccountOnboardingStatus(data.onboarding_status as string | null | undefined),
    requirementsDueAt: typeof data.requirements_due_at === "string" ? data.requirements_due_at : null,
    activatedAt: typeof data.activated_at === "string" ? data.activated_at : null,
    firstPaidAt: typeof data.first_paid_at === "string" ? data.first_paid_at : null,
    guaranteeEndsAt: typeof data.guarantee_ends_at === "string" ? data.guarantee_ends_at : null,
  };
}

export async function getOpsBillingAccountBySlug(slug: string): Promise<OpsBillingAccount | null> {
  const normalizedSlug = slug.trim();
  if (!normalizedSlug || isPlaceholderSupabaseConfig()) {
    return null;
  }

  let { data, error } = await supabaseAdmin
    .from("accounts")
    .select(
      "id, slug, name, billing_status, billing_policy, billing_policy_updated_at, onboarding_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_payment_method_id, stripe_subscription_status, trial_ends_at, current_period_end, cancel_at_period_end, requirements_due_at, activated_at, first_paid_at, guarantee_ends_at, billing_attention_since, billing_updated_at, canceled_at, onboarding_status_updated_at, setup_fee_cents, setup_fee_status, setup_fee_checkout_session_id, setup_fee_payment_intent_id, setup_fee_paid_at, setup_fee_waived_at, setup_fee_waiver_reason, setup_fee_refunded_at, setup_fee_refunded_cents, setup_fee_dispute_status, monthly_price_cents",
    )
    .eq("slug", normalizedSlug)
    .maybeSingle();

  if (error?.message.includes("billing_policy")) {
    console.warn("accounts.billing_policy is missing. Apply the Phase 1 Stripe-authority migration.");
    ({ data, error } = await supabaseAdmin
      .from("accounts")
      .select(
        "id, slug, name, billing_status, onboarding_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_payment_method_id, stripe_subscription_status, trial_ends_at, current_period_end, cancel_at_period_end, requirements_due_at, activated_at, first_paid_at, guarantee_ends_at, billing_attention_since, billing_updated_at, canceled_at, onboarding_status_updated_at, setup_fee_cents, setup_fee_status, setup_fee_checkout_session_id, setup_fee_payment_intent_id, setup_fee_paid_at, setup_fee_waived_at, setup_fee_waiver_reason, setup_fee_refunded_at, setup_fee_refunded_cents, setup_fee_dispute_status, monthly_price_cents",
      )
      .eq("slug", normalizedSlug)
      .maybeSingle());
  }

  if (error) {
    if (
      error.message.includes("billing_status") ||
      error.message.includes("stripe_subscription_id") ||
      error.message.includes("trial_ends_at") ||
      error.message.includes("setup_fee_status")
    ) {
      console.warn("Account billing lifecycle columns are missing. Run supabase.sql before using operator billing controls.");
      return null;
    }

    throwIfSupabaseError(error);
  }

  if (!data) return null;

  return {
    accountId: String(data.id),
    accountSlug: String(data.slug),
    businessName: String(data.name),
    billingStatus: normalizeAccountBillingStatus(data.billing_status as string | null | undefined),
    billingPolicy: normalizeAccountBillingPolicy(
      data.billing_policy as string | null | undefined,
      data.billing_status as string | null | undefined,
      data.setup_fee_status as string | null | undefined,
    ),
    onboardingStatus: normalizeAccountOnboardingStatus(data.onboarding_status as string | null | undefined),
    stripeCustomerId: typeof data.stripe_customer_id === "string" ? data.stripe_customer_id : null,
    stripeSubscriptionId: typeof data.stripe_subscription_id === "string" ? data.stripe_subscription_id : null,
    stripePriceId: typeof data.stripe_price_id === "string" ? data.stripe_price_id : null,
    stripePaymentMethodId: typeof data.stripe_payment_method_id === "string" ? data.stripe_payment_method_id : null,
    stripeSubscriptionStatus: normalizeAccountStripeSubscriptionStatus(data.stripe_subscription_status as string | null | undefined),
    trialEndsAt: typeof data.trial_ends_at === "string" ? data.trial_ends_at : null,
    currentPeriodEnd: typeof data.current_period_end === "string" ? data.current_period_end : null,
    cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
    requirementsDueAt: typeof data.requirements_due_at === "string" ? data.requirements_due_at : null,
    activatedAt: typeof data.activated_at === "string" ? data.activated_at : null,
    firstPaidAt: typeof data.first_paid_at === "string" ? data.first_paid_at : null,
    guaranteeEndsAt: typeof data.guarantee_ends_at === "string" ? data.guarantee_ends_at : null,
    billingAttentionSince: typeof data.billing_attention_since === "string" ? data.billing_attention_since : null,
    billingUpdatedAt: typeof data.billing_updated_at === "string" ? data.billing_updated_at : null,
    canceledAt: typeof data.canceled_at === "string" ? data.canceled_at : null,
    onboardingStatusUpdatedAt:
      typeof data.onboarding_status_updated_at === "string" ? data.onboarding_status_updated_at : null,
    setupFeeCents: Number(data.setup_fee_cents ?? 15000),
    setupFeeStatus: normalizeSetupFeeStatus(data.setup_fee_status as string | null | undefined),
    setupFeeCheckoutSessionId: typeof data.setup_fee_checkout_session_id === "string" ? data.setup_fee_checkout_session_id : null,
    setupFeePaymentIntentId: typeof data.setup_fee_payment_intent_id === "string" ? data.setup_fee_payment_intent_id : null,
    setupFeePaidAt: typeof data.setup_fee_paid_at === "string" ? data.setup_fee_paid_at : null,
    setupFeeWaivedAt: typeof data.setup_fee_waived_at === "string" ? data.setup_fee_waived_at : null,
    setupFeeWaiverReason: typeof data.setup_fee_waiver_reason === "string" ? data.setup_fee_waiver_reason : null,
    setupFeeRefundedAt: typeof data.setup_fee_refunded_at === "string" ? data.setup_fee_refunded_at : null,
    setupFeeRefundedCents: Number(data.setup_fee_refunded_cents ?? 0),
    setupFeeDisputeStatus: typeof data.setup_fee_dispute_status === "string" ? data.setup_fee_dispute_status : null,
    monthlyPriceCents: Number(data.monthly_price_cents ?? 9900),
  };
}

export function canMoveAccountToCustomerDelay(
  status: AccountOnboardingStatus,
  lifecycleDates?: {
    activatedAt?: string | null;
    firstPaidAt?: string | null;
    guaranteeEndsAt?: string | null;
  },
) {
  if (lifecycleDates?.activatedAt || lifecycleDates?.firstPaidAt || lifecycleDates?.guaranteeEndsAt) {
    return false;
  }

  return (
    status === "requirements_needed" ||
    status === "waiting_on_customer" ||
    status === "paused_incomplete" ||
    status === "closed_incomplete"
  );
}

export async function markAccountRequirementsRequested(input: {
  accountId: string;
  nowIso?: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  previousOnboardingStatus?: AccountOnboardingStatus | null;
}) {
  const accountId = assertAccountIdForAccountStore(input.accountId, "markAccountRequirementsRequested");
  const now = input.nowIso ? new Date(input.nowIso) : new Date();
  const requirementsDueAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const previousStatus = input.previousOnboardingStatus ?? null;

  await updateAccountBillingRecord(accountId, {
    onboardingStatus: "waiting_on_customer",
    requirementsDueAt,
  });

  if (!shouldSkipDatabaseWrite("account audit event", input)) {
    const { error } = await supabaseAdmin.from("account_audit_events").insert({
      account_id: accountId,
      actor_user_id: input.actorUserId ?? null,
      actor_email: input.actorEmail ?? null,
      action: previousStatus === "paused_incomplete" || previousStatus === "closed_incomplete"
        ? "onboarding.requirements_reopened"
        : "onboarding.requirements_requested",
      summary: previousStatus === "paused_incomplete" || previousStatus === "closed_incomplete"
        ? `Reopened customer requirements from ${previousStatus}; due ${requirementsDueAt}. Durable activation and guarantee dates were not reset.`
        : `Requested customer requirements; due ${requirementsDueAt}.`,
    });

    if (error) {
      console.warn("Could not record customer requirements audit event.", {
        accountId,
        error: error.message,
      });
    }
  }

  return { requirementsDueAt };
}

export async function resolveAccountByTwilioNumber(phoneNumber: string | null | undefined) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber ?? "");

  if (!normalizedPhone || isPlaceholderSupabaseConfig()) {
    return process.env.NODE_ENV === "production"
      ? { status: "unresolved", reason: "missing_or_placeholder_twilio_number", lookupValue: normalizedPhone || null } satisfies AccountResolution
      : { status: "resolved", account: envAccountConfig() } satisfies AccountResolution;
  }

  const { data, error } = await supabaseAdmin
    .from("account_phone_numbers")
    .select("account_id")
    .eq("phone_number", normalizedPhone)
    .maybeSingle();

  if (error) {
    if (error.message.includes("account_phone_numbers")) {
      console.warn("Account phone number table is missing. Falling back to env account config.");
      return process.env.NODE_ENV === "production"
        ? { status: "unresolved", reason: "account_phone_numbers_table_missing", lookupValue: normalizedPhone } satisfies AccountResolution
        : { status: "resolved", account: envAccountConfig() } satisfies AccountResolution;
    }

    throw error;
  }

  const account = await getAccountConfigByAccountId(data?.account_id);

  return account
    ? { status: "resolved", account } satisfies AccountResolution
    : { status: "unresolved", reason: "twilio_number_not_registered", lookupValue: normalizedPhone } satisfies AccountResolution;
}

export async function resolveAccountByCallSid(callSid: string | null | undefined) {
  const normalizedCallSid = callSid?.trim();

  if (!normalizedCallSid || isPlaceholderSupabaseConfig()) {
    return process.env.NODE_ENV === "production"
      ? { status: "unresolved", reason: "missing_or_placeholder_call_sid", lookupValue: normalizedCallSid ?? null } satisfies AccountResolution
      : { status: "resolved", account: envAccountConfig() } satisfies AccountResolution;
  }

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("account_id")
    .eq("call_sid", normalizedCallSid)
    .maybeSingle();

  if (error) {
    if (error.message.includes("calls")) {
      return process.env.NODE_ENV === "production"
        ? { status: "unresolved", reason: "calls_table_missing", lookupValue: normalizedCallSid } satisfies AccountResolution
        : { status: "resolved", account: envAccountConfig() } satisfies AccountResolution;
    }

    throw error;
  }

  const account = await getAccountConfigByAccountId(data?.account_id);

  return account
    ? { status: "resolved", account } satisfies AccountResolution
    : { status: "unresolved", reason: "call_sid_not_registered", lookupValue: normalizedCallSid } satisfies AccountResolution;
}

export async function resolveAccountByMessageSid(messageSid: string | null | undefined) {
  const normalizedMessageSid = messageSid?.trim();

  if (!normalizedMessageSid || isPlaceholderSupabaseConfig()) {
    return process.env.NODE_ENV === "production"
      ? { status: "unresolved", reason: "missing_or_placeholder_message_sid", lookupValue: normalizedMessageSid ?? null } satisfies AccountResolution
      : { status: "resolved", account: envAccountConfig() } satisfies AccountResolution;
  }

  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("account_id")
    .eq("twilio_message_sid", normalizedMessageSid)
    .maybeSingle();

  if (error) {
    if (error.message.includes("messages")) {
      return process.env.NODE_ENV === "production"
        ? { status: "unresolved", reason: "messages_table_missing", lookupValue: normalizedMessageSid } satisfies AccountResolution
        : { status: "resolved", account: envAccountConfig() } satisfies AccountResolution;
    }

    throw error;
  }

  const account = await getAccountConfigByAccountId(data?.account_id);

  return account
    ? { status: "resolved", account } satisfies AccountResolution
    : { status: "unresolved", reason: "message_sid_not_registered", lookupValue: normalizedMessageSid } satisfies AccountResolution;
}

export async function provisionAccount(input: {
  slug: string;
  businessName: string;
  ownerPhoneNumber: string;
  twilioPhoneNumber?: string | null;
  intakeUrl: string;
  schedulingUrl?: string | null;
  callMode?: "direct" | "forwarding";
  smsEnabled?: boolean;
  ownerEmail?: string | null;
  ownerName?: string | null;
  businessType?: string | null;
  publicBusinessNumber?: string | null;
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
      owner_name: input.ownerName ?? null,
      owner_phone_number: normalizePhoneNumber(input.ownerPhoneNumber),
      business_type: input.businessType ?? null,
      public_business_number: input.publicBusinessNumber
        ? normalizePhoneNumber(input.publicBusinessNumber)
        : null,
      intake_url: input.intakeUrl,
      scheduling_url: input.schedulingUrl ?? input.intakeUrl,
      call_mode: input.callMode ?? "forwarding",
      sms_enabled: input.smsEnabled ?? false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id" });

  throwIfSupabaseError(settingsError);

  if (input.twilioPhoneNumber) {
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
  }

  if (input.ownerEmail) {
    const { error: membershipError } = await supabaseAdmin
      .from("account_users")
      .upsert({
        account_id: accountId,
        email: input.ownerEmail.trim().toLowerCase(),
        role: "owner",
      }, { onConflict: "account_id,email" });
    throwIfSupabaseError(membershipError);
  }

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

export type AccountSettingsUpdate = Partial<{
  business_name: string;
  owner_email: string | null;
  owner_name: string | null;
  legal_business_name: string | null;
  public_business_number: string | null;
  business_type: string | null;
  business_industry: string | null;
  website_url: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  address_city: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  address_country: string;
  business_hours: Record<string, unknown> | null;
  implementation_notes: string | null;
  greeting_preference: "generated" | "recorded";
  a2p_registration_status: "not_started" | "in_progress" | "approved" | "rejected" | "paused";
  call_mode: "direct" | "forwarding";
  owner_phone_number: string;
  scheduling_url: string | null;
  sms_enabled: boolean;
  sms_template: string | null;
  quick_reply_templates: string[] | null;
  missed_call_voice_message: string | null;
  missed_call_greeting_audio_url: string | null;
  dial_timeout_seconds: number;
  voicemail_max_seconds: number;
  missed_call_sms_cooldown_hours: number;
  typical_job_value_cents: number | null;
}>;

export async function updateAccountSettings(accountId: string, update: AccountSettingsUpdate) {
  if (!accountId) {
    throw new Error("Missing account_id for settings update.");
  }

  const { error } = await supabaseAdmin
    .from("account_settings")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("account_id", accountId);

  if (error) {
    throw error;
  }
}

export async function getA2pRegistrationStatus(accountId: string) {
  const { data, error } = await supabaseAdmin
    .from("account_settings")
    .select("a2p_registration_status")
    .eq("account_id", accountId)
    .maybeSingle();

  if (error) {
    console.error("Could not read a2p_registration_status; treating as not approved", {
      accountId,
      error: error.message,
    });
    return null;
  }

  return (data?.a2p_registration_status as string | undefined) ?? null;
}

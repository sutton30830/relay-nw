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
  voicemail_transcription_enabled: boolean | null;
  accounts?: { slug: string } | Array<{ slug: string }> | null;
};

type AccountBillingRow = {
  billing_status: string | null;
  onboarding_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
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
  onboarding_status_updated_at: string | null;
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

const DEFAULT_BILLING_RECORD: AccountBillingRecord = {
  billingStatus: "not_started",
  onboardingStatus: "requirements_needed",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripePriceId: null,
  stripeSubscriptionStatus: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  requirementsDueAt: null,
  activatedAt: null,
  firstPaidAt: null,
  guaranteeEndsAt: null,
  billingAttentionSince: null,
  billingUpdatedAt: null,
  onboardingStatusUpdatedAt: null,
};

function defaultAccountBillingRecord(): AccountBillingRecord {
  return { ...DEFAULT_BILLING_RECORD };
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

function normalizeAccountOnboardingStatus(value: string | null | undefined): AccountOnboardingStatus {
  if (
    value === "requirements_needed" ||
    value === "waiting_on_customer" ||
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

const ACCOUNT_SETTINGS_SELECT =
  "account_id, business_name, owner_email, owner_phone_number, intake_url, scheduling_url, call_mode, sms_enabled, sms_template, quick_reply_templates, missed_call_voice_message, missed_call_voice_name, missed_call_greeting_audio_url, voicemail_max_seconds, dial_timeout_seconds, missed_call_sms_cooldown_hours, voicemail_transcription_enabled, accounts(slug)";
// Same columns minus quick_reply_templates, for a deploy that lands before the
// supabase.sql migration adds the column. Account config is on every request's
// critical path, so a missing optional column must degrade, not throw.
const ACCOUNT_SETTINGS_SELECT_LEGACY =
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
    quickReplyTemplates: null,
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
    quickReplyTemplates: row.quick_reply_templates ?? null,
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

  const [settingsResult, primaryNumber] = await Promise.all([
    supabaseAdmin
      .from("account_settings")
      .select(ACCOUNT_SETTINGS_SELECT)
      .eq("account_id", accountId)
      .maybeSingle(),
    getPrimaryAccountPhoneNumber(accountId),
  ]);

  let { data, error } = settingsResult;

  if (error?.message.includes("quick_reply_templates")) {
    console.warn("account_settings.quick_reply_templates is missing. Run supabase.sql to enable editable quick replies.");
    ({ data, error } = await supabaseAdmin
      .from("account_settings")
      .select(ACCOUNT_SETTINGS_SELECT_LEGACY)
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

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select(
      "billing_status, onboarding_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_subscription_status, trial_ends_at, current_period_end, cancel_at_period_end, requirements_due_at, activated_at, first_paid_at, guarantee_ends_at, billing_attention_since, billing_updated_at, onboarding_status_updated_at",
    )
    .eq("id", accountId)
    .maybeSingle();

  if (error) {
    if (
      error.message.includes("billing_status") ||
      error.message.includes("onboarding_status") ||
      error.message.includes("stripe_customer_id") ||
      error.message.includes("stripe_subscription_id") ||
      error.message.includes("stripe_subscription_status") ||
      error.message.includes("current_period_end") ||
      error.message.includes("activated_at")
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
    onboardingStatus: normalizeAccountOnboardingStatus(row.onboarding_status),
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
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
    onboardingStatusUpdatedAt: row.onboarding_status_updated_at,
  };
}

export async function updateAccountBillingRecord(
  accountId: string,
  update: Partial<AccountBillingRecord>,
) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  const payload: Record<string, string | boolean | null> = {
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
  if (update.onboardingStatus !== undefined) {
    payload.onboarding_status = update.onboardingStatus;
    payload.onboarding_status_updated_at = new Date().toISOString();
  }
  if (update.stripeCustomerId !== undefined) payload.stripe_customer_id = update.stripeCustomerId;
  if (update.stripeSubscriptionId !== undefined) payload.stripe_subscription_id = update.stripeSubscriptionId;
  if (update.stripePriceId !== undefined) payload.stripe_price_id = update.stripePriceId;
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

export type AccountSettingsUpdate = Partial<{
  business_name: string;
  owner_email: string | null;
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

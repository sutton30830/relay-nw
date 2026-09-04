import { activateStripeTrialForAccount } from "@/lib/billing-activation";
import {
  notifyOwnerInboundReply,
  notifyOwnerOptOut,
} from "@/lib/email";
import { env } from "@/lib/env";
import { handleMissedCall } from "@/lib/missed-call";
import { normalizePhoneNumber } from "@/lib/phone";
import { sendOwnerSms } from "@/lib/telephony/owner-sms";
import type { RelayVoiceInstruction } from "@/lib/telephony/provider";
import type {
  CallCompletionEvent,
  InboundCallEvent,
  InboundMessageEvent,
  MessageDeliveryStatus,
  MessageDeliveryUpdateEvent,
  RecordingReadyEvent,
} from "@/lib/telephony/types";
import {
  assertTenantAccount,
  clearOptOut,
  createInboundMessageIfNew,
  createMessageIfNew,
  getAccountConfigByAccountId,
  getOutboundMessageLeadIdByProviderId,
  recordOptOut,
  recordProviderAction,
  recordAutomaticSmsAttempt,
  recordSmsOnboardingEvidence,
  resolveAccountByProviderCallId,
  resolveAccountByProviderMessageId,
  resolveAccountByRelayPhoneNumber,
  resolveAccountSafely,
  resolveConsistentAccountEvidence,
  type AccountResolution,
  type SmsStatus,
  type TenantAccountRuntimeConfig,
  updateCallRecordingByProviderCallId,
  updateLeadRecordingByProviderCallId,
  updateLeadSmsStatus,
  updateLeadSmsStatusByProviderMessageId,
  updateLeadVoicemailTranscription,
  updateMessageStatusByProviderMessageId,
  upsertCall,
} from "@/lib/supabase";
import {
  isExpectedVoicemailQualityErrorMessage,
  transcribeLeadVoicemail,
} from "@/lib/voicemail-ai";
import {
  NO_USABLE_VOICEMAIL_MESSAGE,
  recordingIsTooShort,
} from "@/lib/voicemail-quality";

const DEFAULT_FORWARDING_MESSAGE =
  "Thanks for calling. Sorry we missed you. We will text you shortly. Please leave a quick recorded message after the tone.";
const OPT_OUT_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN_WORDS = new Set(["START", "UNSTOP", "YES"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);
const TRACKED_DELIVERY_STATUSES = new Set<MessageDeliveryStatus>([
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "undelivered",
]);

export type RelayWebhookRequestSummary = Record<string, unknown>;

export type DeliveryCallbackContext = {
  messageType: "auto_text" | "manual_reply";
  accountId: string | null;
  leadId: string | null;
  actionKey: string | null;
};

export type InboundMessageAction =
  | "recorded_opt_out"
  | "recorded_opt_in"
  | "answered_help"
  | "notified_owner"
  | "forwarded_to_owner"
  | "ignored_empty_message"
  | "ignored_owner_message"
  | "duplicate_ignored";

export function resolveInboundCallAccount(event: InboundCallEvent) {
  return resolveAccountSafely(async () => {
    const [byCallId, byNumber] = await Promise.all([
      resolveAccountByProviderCallId(event.callId?.value),
      resolveAccountByRelayPhoneNumber(event.to),
    ]);

    return resolveConsistentAccountEvidence([
      { label: "call identifier", resolution: byCallId },
      { label: "destination number", resolution: byNumber },
    ]);
  }, "inbound call");
}

export function resolveCallCompletionAccount(event: CallCompletionEvent) {
  return resolveAccountSafely(async () => {
    const [byCallId, byNumber] = await Promise.all([
      resolveAccountByProviderCallId(event.callId?.value),
      resolveAccountByRelayPhoneNumber(event.to),
    ]);

    const resolution = resolveConsistentAccountEvidence([
      { label: "call identifier", resolution: byCallId },
      { label: "destination number", resolution: byNumber },
    ]);
    if (byCallId.status === "unresolved" && byNumber.status === "resolved") {
      console.warn("call result resolved by destination-number fallback; call row was missing", {
        providerCallId: event.callId?.value ?? null,
      });
    }
    return resolution;
  }, "call result");
}

export function resolveRecordingAccount(event: RecordingReadyEvent) {
  return resolveAccountSafely(async () => {
    const [byCallId, byNumber] = await Promise.all([
      resolveAccountByProviderCallId(event.callId?.value),
      resolveAccountByRelayPhoneNumber(event.to),
    ]);

    const resolution = resolveConsistentAccountEvidence([
      { label: "call identifier", resolution: byCallId },
      { label: "destination number", resolution: byNumber },
    ]);
    if (byCallId.status === "unresolved" && byNumber.status === "resolved") {
      console.warn("recording resolved by destination-number fallback; call row was missing", {
        providerCallId: event.callId?.value ?? null,
        providerRecordingId: event.recordingId?.value ?? null,
      });
    }
    return resolution;
  }, "recording");
}

export function resolveInboundMessageAccount(event: InboundMessageEvent) {
  const destination = normalizePhoneNumber(event.to);
  return resolveAccountSafely(async () => {
    const [byMessageId, byNumber] = await Promise.all([
      resolveAccountByProviderMessageId(event.messageId?.value),
      resolveAccountByRelayPhoneNumber(destination || event.to),
    ]);

    return resolveConsistentAccountEvidence([
      { label: "message identifier", resolution: byMessageId },
      { label: "destination number", resolution: byNumber },
    ]);
  }, "inbound message");
}

export function resolveMessageDeliveryAccount(
  event: MessageDeliveryUpdateEvent,
  callback: DeliveryCallbackContext,
) {
  return resolveAccountSafely(async () => {
    const byMessageId = await resolveAccountByProviderMessageId(event.messageId?.value);
    if (!callback.accountId) return byMessageId;

    const account = await getAccountConfigByAccountId(callback.accountId);
    const byCallbackAccount: AccountResolution = account
      ? { status: "resolved", account }
      : {
          status: "unresolved",
          reason: "sms_callback_account_not_registered",
          lookupValue: callback.accountId,
        };

    return resolveConsistentAccountEvidence([
      { label: "message identifier", resolution: byMessageId },
      { label: "callback account", resolution: byCallbackAccount },
    ]);
  }, "message delivery update");
}

export function tenantAccount(resolution: AccountResolution, label: string) {
  if (resolution.status === "unresolved") {
    throw new Error(`Cannot use an unresolved account for ${label}.`);
  }
  return assertTenantAccount(resolution.account, label);
}

export function inboundCallVoiceInstructions(input: {
  account: TenantAccountRuntimeConfig;
  event: InboundCallEvent;
  callResultCallbackUrl: string;
  recordingCallbackUrl: string;
}): RelayVoiceInstruction[] {
  const callerId = input.event.from || input.account.relayPhoneNumber || input.account.twilioPhoneNumber;

  if (input.account.callMode === "direct") {
    return [{
      type: "forward_to_owner",
      ownerPhoneNumber: input.account.ownerPhoneNumber,
      callerId,
      completionCallbackUrl: input.callResultCallbackUrl,
      timeoutSeconds: input.account.dialTimeoutSeconds,
    }];
  }

  const greeting: Extract<RelayVoiceInstruction, { type: "play_greeting" }> = {
    type: "play_greeting",
    greeting: input.account.missedCallGreetingAudioUrl
      ? { type: "audio", url: input.account.missedCallGreetingAudioUrl }
      : {
          type: "text",
          text: input.account.missedCallVoiceMessage || DEFAULT_FORWARDING_MESSAGE,
          voice: input.account.missedCallVoiceName,
        },
  };

  return [
    greeting,
    {
      type: "capture_voicemail",
      completionCallbackUrl: input.recordingCallbackUrl,
      maxDurationSeconds: input.account.voicemailMaxSeconds,
      silenceTimeoutSeconds: 5,
      trimSilence: true,
      playBeep: true,
    },
  ];
}

export function rejectedCallVoiceInstructions(): RelayVoiceInstruction[] {
  return [{
    type: "reject_safely",
    message: "We are unable to route this call right now. Please try again later.",
    voice: "Polly.Joanna-Neural",
  }];
}

export async function processInboundCall(input: {
  account: TenantAccountRuntimeConfig;
  event: InboundCallEvent;
  correlationId: string;
  requestSummary: RelayWebhookRequestSummary;
  signatureValid: boolean;
}) {
  const callId = input.event.callId?.value ?? "";
  const callerPhone = input.event.from || input.account.relayPhoneNumber || input.account.twilioPhoneNumber;
  const isForwarding = input.account.callMode === "forwarding";

  await upsertCall({
    accountId: input.account.accountId,
    providerCallId: callId,
    parentProviderCallId: input.event.parentCallId?.value ?? null,
    fromPhone: callerPhone,
    toPhone: input.event.to || null,
    status: isForwarding ? "missed" : "ringing",
    rawSummary: input.requestSummary,
  });

  if (!isForwarding) {
    return { mode: "direct" as const, smsStatus: null, becameLive: false };
  }

  const result = await handleMissedCall({
    account: input.account,
    providerCallId: callId,
    callerPhone,
    message: null,
    correlationId: input.correlationId,
    providerSignatureValid: input.signatureValid,
  });

  return {
    mode: "forwarding" as const,
    smsStatus: result.smsStatus,
    becameLive: result.becameLive,
  };
}

export function callCompletionKind(event: CallCompletionEvent) {
  if (["no_answer", "busy", "failed", "canceled"].includes(event.outcome)) {
    return "missed" as const;
  }
  if (["completed", "answered"].includes(event.outcome)) {
    return "connected" as const;
  }
  return "unhandled" as const;
}

export async function processCallCompletion(input: {
  account: TenantAccountRuntimeConfig;
  event: CallCompletionEvent;
  correlationId: string;
  requestSummary: RelayWebhookRequestSummary;
  signatureValid: boolean;
}) {
  const callId = input.event.callId?.value ?? "";
  const providerStatus = input.event.providerStatus ?? "";
  const kind = callCompletionKind(input.event);

  await upsertCall({
    accountId: input.account.accountId,
    providerCallId: callId,
    parentProviderCallId: input.event.parentCallId?.value ?? null,
    fromPhone: input.event.from,
    toPhone: input.event.to || null,
    status: kind === "missed" ? "missed" : providerStatus || null,
    dialCallStatus: providerStatus,
    rawSummary: input.requestSummary,
  });

  if (kind !== "missed") {
    return { kind, smsStatus: null, becameLive: false };
  }

  const result = await handleMissedCall({
    account: input.account,
    providerCallId: callId,
    callerPhone: input.event.from,
    message: `Missed call. Dial status: ${providerStatus}.`,
    correlationId: input.correlationId,
    providerSignatureValid: input.signatureValid,
  });

  return { kind, smsStatus: result.smsStatus, becameLive: result.becameLive };
}

export async function activateTrialAfterFirstMissedCall(
  account: TenantAccountRuntimeConfig,
) {
  if (!account.smsEnabled) return;
  await activateStripeTrialForAccount(account.accountId);
}

export async function attachRecording(input: {
  account: TenantAccountRuntimeConfig;
  event: RecordingReadyEvent;
}) {
  const callId = input.event.callId?.value ?? "";
  const callerPhone = normalizePhoneNumber(input.event.from);
  const recordingId = input.event.recordingId?.value ?? null;
  const recordingStatus = input.event.providerStatus;

  if (!callId) {
    return {
      updated: false,
      leadId: null,
      missingCallId: true,
      matchedBy: null,
    };
  }

  const recording = {
    providerCallId: callId,
    callerPhone,
    providerRecordingId: recordingId,
    recordingUrl: input.event.mediaUrl,
    recordingDuration: input.event.durationSeconds,
    recordingStatus,
  };

  await updateCallRecordingByProviderCallId({
    accountId: input.account.accountId,
    ...recording,
  });
  const result = await updateLeadRecordingByProviderCallId({
    accountId: input.account.accountId,
    ...recording,
  });

  return {
    updated: result.updated,
    leadId: result.leadId,
    missingCallId: false,
    matchedBy: result.matchedBy ?? null,
  };
}

export function shouldAutoTranscribeRecording(event: RecordingReadyEvent) {
  if (!event.recordingId || recordingIsTooShort(event.durationSeconds)) return false;
  return event.status === "ready" || event.status === "unknown";
}

export async function markTooShortRecording(input: {
  account: TenantAccountRuntimeConfig;
  event: RecordingReadyEvent;
  leadId: string | null;
}) {
  if (!input.leadId || !recordingIsTooShort(input.event.durationSeconds)) return false;

  await updateLeadVoicemailTranscription({
    accountId: input.account.accountId,
    id: input.leadId,
    rawTranscript: null,
    transcriptionModel: env.openaiTranscriptionModel,
    transcriptionConfidence: null,
    transcriptionQuality: "unavailable",
    transcriptionQualityReasons: ["recording_too_short"],
    transcriptionMetrics: null,
    transcript: null,
    summary: null,
    summaryClassification: null,
    summaryEvidence: null,
    summaryValidationReasons: null,
    status: "failed",
    error: NO_USABLE_VOICEMAIL_MESSAGE,
  });
  return true;
}

export async function transcribeEligibleRecording(input: {
  account: TenantAccountRuntimeConfig;
  event: RecordingReadyEvent;
  leadId: string | null;
}) {
  if (
    !input.account.voicemailTranscriptionEnabled ||
    !input.leadId ||
    !shouldAutoTranscribeRecording(input.event)
  ) {
    return { outcome: "not_eligible" as const, error: null };
  }

  try {
    await transcribeLeadVoicemail(input.leadId, input.account.accountId);
    return { outcome: "completed" as const, error: null };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unknown voicemail transcription error";
    if (message === "Voicemail summary is already generating.") {
      return { outcome: "duplicate" as const, error: message };
    }
    if (isExpectedVoicemailQualityErrorMessage(message)) {
      return { outcome: "quality_suppressed" as const, error: message };
    }
    return { outcome: "failed" as const, error: message };
  }
}

function normalizedKeyword(body: string) {
  return body.trim().toUpperCase();
}

export function inboundMessageIntent(event: InboundMessageEvent) {
  const from = normalizePhoneNumber(event.from);
  const body = event.body.trim();
  const keyword = normalizedKeyword(body);
  return {
    from,
    to: normalizePhoneNumber(event.to),
    body,
    isOptOut: Boolean(from) && OPT_OUT_WORDS.has(keyword),
    isOptIn: Boolean(from) && OPT_IN_WORDS.has(keyword),
    isHelp: Boolean(from) && HELP_WORDS.has(keyword),
    shouldNotifyOwner: Boolean(from && body),
  };
}

export async function processInboundMessage(input: {
  account: TenantAccountRuntimeConfig;
  event: InboundMessageEvent;
  correlationId: string;
}): Promise<InboundMessageAction> {
  const message = inboundMessageIntent(input.event);
  const messageId = input.event.messageId?.value ?? "";

  if (messageId && message.from && message.body) {
    const inbound = await createInboundMessageIfNew({
      accountId: input.account.accountId,
      providerMessageId: messageId,
      fromPhone: message.from,
      toPhone: message.to || null,
      body: message.body,
    });
    if (!inbound.inserted) return "duplicate_ignored";

    await createMessageIfNew({
      accountId: input.account.accountId,
      providerMessageId: messageId,
      direction: "inbound",
      fromPhone: message.from,
      toPhone: message.to || null,
      body: message.body,
      status: "received",
    });
  }

  if (message.from && message.from === input.account.ownerPhoneNumber) {
    return "ignored_owner_message";
  }
  if (message.isOptIn) {
    await clearOptOut(message.from, input.account.accountId);
    return "recorded_opt_in";
  }
  if (message.isHelp) return "answered_help";
  if (message.isOptOut) {
    await recordOptOut(message.from, input.account.accountId);
    await notifyOwnerOptOut({
      account: input.account,
      callerPhone: message.from,
      notificationId: input.correlationId,
    });
    return "recorded_opt_out";
  }

  if (message.shouldNotifyOwner) {
    await notifyOwnerInboundReply({
      account: input.account,
      callerPhone: message.from,
      body: message.body,
      notificationId: input.correlationId,
    });
  }

  const shouldTextOwner = message.shouldNotifyOwner &&
    (input.account.notificationPreferences?.inboundReply.sms ?? true);
  if (message.shouldNotifyOwner && !shouldTextOwner) return "notified_owner";
  if (shouldTextOwner && !input.account.smsEnabled) return "notified_owner";

  if (shouldTextOwner) {
    await sendOwnerSms({
      account: input.account,
      context: "inbound caller reply",
      actionKey: `owner_sms:inbound_reply:${input.correlationId}`,
      body: `New Relay reply from ${message.from}:\n${message.body}\n\nOpen leads: ${env.appBaseUrl}/leads`,
    });
    return "forwarded_to_owner";
  }

  return "ignored_empty_message";
}

export function deliveryCallbackContextIsConsistent(input: DeliveryCallbackContext) {
  if (!input.leadId || !input.actionKey) return false;
  return input.messageType === "auto_text"
    ? input.actionKey === `automatic_missed_call_sms:${input.leadId}`
    : input.actionKey.startsWith(`manual_reply:${input.leadId}:`);
}

function providerErrorCode(event: MessageDeliveryUpdateEvent) {
  return event.error?.code?.match(/\b(?:21|30)\d{3}\b/)?.[0] ??
    event.error?.message?.match(/\b(?:21|30)\d{3}\b/)?.[0] ??
    null;
}

export async function processMessageDeliveryUpdate(input: {
  account: TenantAccountRuntimeConfig;
  event: MessageDeliveryUpdateEvent;
  callback: DeliveryCallbackContext;
  correlationId: string;
}) {
  const messageId = input.event.messageId?.value ?? "";
  const status = TRACKED_DELIVERY_STATUSES.has(input.event.status)
    ? input.event.status as Exclude<SmsStatus, null>
    : null;
  const error = input.event.error?.message ?? input.event.error?.code ?? null;
  const callbackIsConsistent = deliveryCallbackContextIsConsistent(input.callback);
  const result = input.callback.messageType === "auto_text" && messageId && status
      ? await updateLeadSmsStatusByProviderMessageId({
        accountId: input.account.accountId,
        providerMessageId: messageId,
        smsStatus: status,
        smsError: error,
      })
    : { updated: false };

  let reconciledLeadId: string | null = null;
  if (input.callback.messageType === "auto_text" && !result.updated && messageId && status) {
    const leadId = await getOutboundMessageLeadIdByProviderId({
      accountId: input.account.accountId,
      providerMessageId: messageId,
    });
    if (leadId) {
      await updateLeadSmsStatus({
        accountId: input.account.accountId,
        id: leadId,
        smsStatus: status,
        smsError: error,
        providerMessageId: messageId,
      });
      reconciledLeadId = leadId;
    }
  }

  if (
    input.callback.messageType === "auto_text" &&
    !result.updated &&
    !reconciledLeadId &&
    messageId &&
    status &&
    callbackIsConsistent
  ) {
    await updateLeadSmsStatus({
      accountId: input.account.accountId,
      id: input.callback.leadId!,
      smsStatus: status,
      smsError: error,
      providerMessageId: messageId,
    });
    reconciledLeadId = input.callback.leadId;
  }

  if (messageId && status) {
    const messageUpdate = await updateMessageStatusByProviderMessageId({
      accountId: input.account.accountId,
      providerMessageId: messageId,
      status,
      error,
    });
    if (!messageUpdate.updated && callbackIsConsistent) {
      await createMessageIfNew({
        accountId: input.account.accountId,
        leadId: input.callback.leadId,
        providerMessageId: messageId,
        direction: "outbound",
        fromPhone: input.event.from || null,
        toPhone: input.event.to || null,
        body: null,
        status,
        error,
      });
    }
  }

  if (messageId && status && typeof recordProviderAction === "function") {
    const terminalSuccess = status === "delivered";
    const terminalFailure = status === "failed" || status === "undelivered";
    await recordProviderAction({
      accountId: input.account.accountId,
      action: input.callback.messageType === "manual_reply"
        ? "manual_reply_sms"
        : "automatic_missed_call_sms",
      provider: input.event.provider,
      idempotencyKey: input.callback.actionKey ?? `sms_delivery_callback:${messageId}`,
      providerIdentifier: messageId,
      resourceType: input.callback.leadId ? "lead" : "message",
      resourceId: input.callback.leadId ?? messageId,
      internalStatus: terminalSuccess ? "succeeded" : terminalFailure ? "failed" : "accepted",
      providerStatus: status,
      failureCode: providerErrorCode(input.event),
      diagnosticDetail: terminalFailure ? error : null,
      customerExplanation: terminalSuccess
        ? "The carrier confirmed this text was delivered."
        : undefined,
      retryEligibility: terminalSuccess ? "never" : undefined,
      recommendedNextAction: terminalSuccess ? "No action is needed." : undefined,
      customerVisible: terminalFailure,
    });
  }

  if (messageId && status && input.callback.messageType === "auto_text" && input.callback.actionKey) {
    try { await recordAutomaticSmsAttempt(input.account.accountId, input.callback.actionKey); }
    catch { console.error("Could not reconcile automatic SMS attempt evidence", { accountId: input.account.accountId }); }
  }

  if (
    input.callback.messageType === "auto_text" &&
    messageId &&
    status &&
    typeof recordSmsOnboardingEvidence === "function"
  ) {
    await recordSmsOnboardingEvidence({
      accountId: input.account.accountId,
      messageSid: messageId,
      status,
      errorCode: providerErrorCode(input.event),
    });
  }

  return {
    messageId,
    status,
    error,
    leadUpdated: result.updated || Boolean(reconciledLeadId),
    reconciledLeadId,
  };
}

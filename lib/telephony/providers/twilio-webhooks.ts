import { after } from "next/server";
import { notifyAdminOperationalIssue } from "@/lib/email";
import { env } from "@/lib/env";
import { phoneLast4 } from "@/lib/phone";
import { getTelephonyProvider } from "@/lib/telephony/registry";
import type {
  CallCompletionEvent,
  MessageDeliveryUpdateEvent,
} from "@/lib/telephony/types";
import {
  activateTrialAfterFirstMissedCall,
  attachRecording,
  inboundCallVoiceInstructions,
  inboundMessageIntent,
  markTooShortRecording,
  processCallCompletion,
  processInboundCall,
  processInboundMessage,
  processMessageDeliveryUpdate,
  rejectedCallVoiceInstructions,
  resolveCallCompletionAccount,
  resolveInboundCallAccount,
  resolveInboundMessageAccount,
  resolveMessageDeliveryAccount,
  resolveRecordingAccount,
  shouldAutoTranscribeRecording,
  tenantAccount,
  transcribeEligibleRecording,
  type DeliveryCallbackContext,
  type InboundMessageAction,
} from "@/lib/telephony/webhook-services";
import {
  logWebhookEvent,
  type TenantAccountRuntimeConfig,
  type WebhookEventSource,
} from "@/lib/supabase";
import {
  logUnsignedTwilioWebhook,
  parseTwilioWebhook,
  rejectInvalidTwilioSignature,
  type ParsedTwilioWebhook,
} from "@/lib/twilio";
import { handleUnresolvedTwilioAccount } from "@/lib/twilio/unresolved-account";
import { emptyTwiml, helpReplyTwiml, twimlResponse } from "@/lib/twiml";

const VOICE_WEBHOOK_SOURCE: WebhookEventSource = "twilio_voice";
const CALL_RESULT_WEBHOOK_SOURCE: WebhookEventSource = "twilio_dial_status";
const RECORDING_WEBHOOK_SOURCE: WebhookEventSource = "twilio_recording";
const INBOUND_MESSAGE_WEBHOOK_SOURCE: WebhookEventSource = "twilio_inbound_sms";
const MESSAGE_DELIVERY_WEBHOOK_SOURCE: WebhookEventSource = "twilio_sms_status";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return fallback;
}

function callbackUrl(request: Request, path: string) {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const requestOrigin = forwardedProto && forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : `${url.protocol}//${url.host}`;
  return `${requestOrigin || env.appBaseUrl}${path}`;
}

function validationNote(matchedUrl: string | null) {
  if (matchedUrl) return `Validated with URL: ${matchedUrl}`;
  return env.allowUnsignedTwilioWebhooks
    ? "Unsigned/invalid Twilio webhook allowed by env override."
    : null;
}

function voiceEventNote(input: {
  matchedUrl: string | null;
  smsStatus?: string | null;
}) {
  const note = validationNote(input.matchedUrl);
  if (!input.smsStatus) return note;
  return note
    ? `${note}${note.endsWith(".") ? "" : ";"} forwarding mode SMS status: ${input.smsStatus}`
    : `Forwarding mode SMS status: ${input.smsStatus}`;
}

async function rejectSignature<Type extends Parameters<typeof parseTwilioWebhook>[1]>(input: {
  ingress: ParsedTwilioWebhook<Type>;
  accountId: string | null;
  source: WebhookEventSource;
  label: string;
  responseBody?: string;
}) {
  return rejectInvalidTwilioSignature({
    source: input.source,
    accountId: input.accountId,
    label: input.label,
    payload: input.ingress.payload,
    correlationId: input.ingress.correlationId,
    requestSummary: input.ingress.requestSummary,
    candidateUrls: input.ingress.validation.candidateUrls,
    hasSignature: input.ingress.validation.hasSignature,
    responseBody: input.responseBody,
  });
}

export async function getTwilioVoiceWebhook() {
  return new Response("Twilio voice webhook requires POST.", {
    status: 405,
    headers: {
      Allow: "POST",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export async function postTwilioVoiceWebhook(request: Request) {
  const ingress = await parseTwilioWebhook(request, "inbound_call");
  const accountResolution = await resolveInboundCallAccount(ingress.event);
  const resolvedAccount = accountResolution.status === "resolved"
    ? accountResolution.account
    : null;

  console.info("Twilio voice webhook received", {
    correlationId: ingress.correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...ingress.requestSummary,
  });

  if (ingress.validation.shouldReject) {
    return rejectSignature({
      ingress,
      accountId: resolvedAccount?.accountId ?? null,
      source: VOICE_WEBHOOK_SOURCE,
      label: "voice",
      responseBody: "Rejected invalid Twilio signature for voice webhook.",
    });
  }
  if (ingress.validation.wasAllowedByOverride) {
    await logUnsignedTwilioWebhook({
      source: VOICE_WEBHOOK_SOURCE,
      accountId: resolvedAccount?.accountId ?? null,
      label: "voice",
      payload: ingress.payload,
      correlationId: ingress.correlationId,
      requestSummary: ingress.requestSummary,
      candidateUrls: ingress.validation.candidateUrls,
      hasSignature: ingress.validation.hasSignature,
      responseBody: "Allowed unsigned Twilio voice webhook by env override.",
    });
  }

  if (accountResolution.status === "unresolved") {
    const rendered = getTelephonyProvider("twilio").renderVoiceInstructions(
      rejectedCallVoiceInstructions(),
    );
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: VOICE_WEBHOOK_SOURCE,
      label: "voice",
      payload: ingress.payload,
      correlationId: ingress.correlationId,
      responseBody: rendered.body,
    });
  }

  const account = tenantAccount(accountResolution, "voice webhook");
  const instructions = inboundCallVoiceInstructions({
    account,
    event: ingress.event,
    callResultCallbackUrl: callbackUrl(request, "/api/twilio/voice-status"),
    recordingCallbackUrl: callbackUrl(request, "/api/twilio/recording"),
  });
  const rendered = getTelephonyProvider("twilio").renderVoiceInstructions(instructions);

  after(async () => {
    try {
      const result = await processInboundCall({
        account,
        event: ingress.event,
        correlationId: ingress.correlationId,
        requestSummary: ingress.requestSummary,
        signatureValid: Boolean(ingress.validation.matchedUrl),
      });

      if (result.becameLive) {
        try {
          await activateTrialAfterFirstMissedCall(account);
        } catch (error) {
          console.error("Deferred trial activation after first missed call failed", {
            accountId: account.accountId,
            correlationId: ingress.correlationId,
            error: errorMessage(error, "Unknown trial activation error"),
          });
        }
      }

      console.info(
        result.mode === "forwarding"
          ? "Handled forwarded missed call"
          : "Recorded direct-mode inbound call",
        {
          correlationId: ingress.correlationId,
          ...ingress.requestSummary,
          ...(result.smsStatus ? { smsStatus: result.smsStatus } : {}),
        },
      );
      await logWebhookEvent({
        accountId: account.accountId,
        source: VOICE_WEBHOOK_SOURCE,
        correlationId: ingress.correlationId,
        payload: ingress.payload,
        responseStatus: rendered.status,
        responseBody: rendered.body,
        error: voiceEventNote({
          matchedUrl: ingress.validation.matchedUrl,
          smsStatus: result.smsStatus,
        }),
      });
    } catch (error) {
      const message = errorMessage(error, "Unknown voice webhook error");
      console.error("Failed to process Twilio voice webhook", {
        correlationId: ingress.correlationId,
        ...ingress.requestSummary,
        error: message,
      });
      try {
        await logWebhookEvent({
          accountId: account.accountId,
          source: VOICE_WEBHOOK_SOURCE,
          correlationId: ingress.correlationId,
          payload: ingress.payload,
          responseStatus: rendered.status,
          responseBody: rendered.body,
          error: message,
          internalStatus: "failed",
          providerStatus: "local_processing_failed",
          customerVisible: true,
        });
      } catch (logError) {
        console.error("Failed to record voice webhook error", {
          correlationId: ingress.correlationId,
          error: errorMessage(logError, "Unknown webhook logging error"),
        });
      }
    }
  });

  return new Response(rendered.body, {
    status: rendered.status,
    headers: { "Content-Type": rendered.contentType },
  });
}

export async function getTwilioCallResultWebhook() {
  return twimlResponse(emptyTwiml());
}

function callResultEventNote(input: {
  matchedUrl: string | null;
  event: CallCompletionEvent;
  smsStatus: string | null;
  unhandled: boolean;
}) {
  const notes = [];
  const validation = validationNote(input.matchedUrl);
  if (validation) notes.push(validation);
  if (input.event.providerStatus) notes.push(`Call status: ${input.event.providerStatus}`);
  if (input.smsStatus) notes.push(`SMS status: ${input.smsStatus}`);
  if (input.unhandled) notes.push("Unhandled call result status.");
  return notes.length ? notes.join(" ") : null;
}

export async function postTwilioCallResultWebhook(request: Request) {
  const ingress = await parseTwilioWebhook(request, "call_completed");
  const accountResolution = await resolveCallCompletionAccount(ingress.event);
  const resolvedAccount = accountResolution.status === "resolved"
    ? accountResolution.account
    : null;
  const xml = emptyTwiml();

  console.info("Twilio call result webhook received", {
    correlationId: ingress.correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...ingress.requestSummary,
  });

  if (ingress.validation.shouldReject) {
    return rejectSignature({
      ingress,
      accountId: resolvedAccount?.accountId ?? null,
      source: CALL_RESULT_WEBHOOK_SOURCE,
      label: "dial status",
      responseBody: "Rejected invalid Twilio signature for dial status webhook.",
    });
  }
  if (ingress.validation.wasAllowedByOverride) {
    await logUnsignedTwilioWebhook({
      source: CALL_RESULT_WEBHOOK_SOURCE,
      accountId: resolvedAccount?.accountId ?? null,
      label: "dial status",
      payload: ingress.payload,
      correlationId: ingress.correlationId,
      requestSummary: ingress.requestSummary,
      candidateUrls: ingress.validation.candidateUrls,
      hasSignature: ingress.validation.hasSignature,
      responseBody: "Allowed unsigned Twilio dial status webhook by env override.",
    });
  }
  if (accountResolution.status === "unresolved") {
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: CALL_RESULT_WEBHOOK_SOURCE,
      label: "dial status",
      payload: ingress.payload,
      correlationId: ingress.correlationId,
      responseBody: xml,
    });
  }

  const account = tenantAccount(accountResolution, "call result webhook");
  try {
    const result = await processCallCompletion({
      account,
      event: ingress.event,
      correlationId: ingress.correlationId,
      requestSummary: ingress.requestSummary,
      signatureValid: Boolean(ingress.validation.matchedUrl),
    });
    if (result.kind === "unhandled") {
      console.warn(`Unhandled call result status: ${ingress.event.providerStatus ?? ""}`, {
        correlationId: ingress.correlationId,
      });
    }
    if (result.becameLive) {
      after(async () => {
        try {
          await activateTrialAfterFirstMissedCall(account);
        } catch (error) {
          console.error("Deferred trial activation after first missed call failed", {
            accountId: account.accountId,
            correlationId: ingress.correlationId,
            error: errorMessage(error, "Unknown trial activation error"),
          });
        }
      });
    }

    await logWebhookEvent({
      accountId: account.accountId,
      source: CALL_RESULT_WEBHOOK_SOURCE,
      correlationId: ingress.correlationId,
      payload: ingress.payload,
      responseStatus: 200,
      responseBody: xml,
      error: callResultEventNote({
        matchedUrl: ingress.validation.matchedUrl,
        event: ingress.event,
        smsStatus: result.smsStatus,
        unhandled: result.kind === "unhandled",
      }),
    });
  } catch (error) {
    const message = errorMessage(error, "Unknown call result webhook error");
    await logWebhookEvent({
      accountId: account.accountId,
      source: CALL_RESULT_WEBHOOK_SOURCE,
      correlationId: ingress.correlationId,
      payload: ingress.payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
      internalStatus: "failed",
      providerStatus: "local_processing_failed",
      customerVisible: true,
    });
    console.error("Failed to handle Twilio call result", {
      correlationId: ingress.correlationId,
      ...ingress.requestSummary,
      callerLast4: phoneLast4(ingress.event.from),
      error: message,
    });
  }

  return twimlResponse(xml);
}

function recordingEventNote(input: {
  matchedUrl: string | null;
  recordingUpdated: boolean;
  recordingMatchedBy: string | null;
  missingCallId: boolean;
}) {
  const notes = [];
  const validation = validationNote(input.matchedUrl);
  if (validation) notes.push(validation);
  if (input.recordingUpdated) {
    notes.push(
      input.recordingMatchedBy === "phone"
        ? "Recording attached to the latest recent lead from this caller."
        : "Recording attached to lead.",
    );
  }
  if (input.missingCallId) notes.push("Skipped recording update because the call identifier was missing.");
  else if (!input.recordingUpdated) notes.push("No lead matched the recording call identifier.");
  return notes.length ? notes.join(" ") : null;
}

async function transcribeRecordingInBackground(input: {
  ingress: ParsedTwilioWebhook<"recording_ready">;
  account: TenantAccountRuntimeConfig;
  xml: string;
  leadId: string | null;
}) {
  const { ingress, account, xml, leadId } = input;
  try {
    const transcription = await transcribeEligibleRecording({
      account,
      event: ingress.event,
      leadId,
    });
    if (transcription.outcome === "duplicate") {
      console.info("Skipping duplicate automatic voicemail transcription", {
        correlationId: ingress.correlationId,
        leadId,
        recordingId: ingress.event.recordingId?.value ?? null,
      });
    } else if (transcription.outcome === "quality_suppressed") {
      console.info("Automatic voicemail transcription suppressed an uncertain result", {
        correlationId: ingress.correlationId,
        leadId,
        recordingId: ingress.event.recordingId?.value ?? null,
        outcome: transcription.error,
      });
    } else if (transcription.outcome === "failed") {
      console.error("Automatic voicemail transcription failed", {
        correlationId: ingress.correlationId,
        leadId,
        recordingId: ingress.event.recordingId?.value ?? null,
        error: transcription.error,
      });
      await logWebhookEvent({
        accountId: account.accountId,
        source: RECORDING_WEBHOOK_SOURCE,
        correlationId: ingress.correlationId,
        payload: ingress.payload,
        responseStatus: 200,
        responseBody: xml,
        error: `Automatic voicemail transcription failed for lead ${leadId}: ${transcription.error}`,
        internalStatus: "failed",
        providerStatus: "transcription_failed",
        customerVisible: true,
      });
    }
  } catch (error) {
    console.error("Failed to record automatic voicemail transcription outcome", {
      correlationId: ingress.correlationId,
      leadId,
      error: errorMessage(error, "Unknown transcription logging error"),
    });
  }
}

export async function postTwilioRecordingWebhook(request: Request) {
  const ingress = await parseTwilioWebhook(request, "recording_ready");
  const accountResolution = await resolveRecordingAccount(ingress.event);
  const resolvedAccount = accountResolution.status === "resolved"
    ? accountResolution.account
    : null;
  const xml = emptyTwiml();

  console.info("Twilio recording webhook received", {
    correlationId: ingress.correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...ingress.requestSummary,
    recordingId: ingress.event.recordingId?.value ?? null,
    recordingDuration: ingress.event.durationSeconds,
    recordingStatus: ingress.event.providerStatus,
  });

  if (ingress.validation.shouldReject) {
    return rejectSignature({
      ingress,
      accountId: resolvedAccount?.accountId ?? null,
      source: RECORDING_WEBHOOK_SOURCE,
      label: "recording",
    });
  }
  if (accountResolution.status === "unresolved") {
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: RECORDING_WEBHOOK_SOURCE,
      label: "recording",
      payload: ingress.payload,
      correlationId: ingress.correlationId,
      responseBody: xml,
    });
  }

  const account = tenantAccount(accountResolution, "recording webhook");
  try {
    const result = await attachRecording({ account, event: ingress.event });
    if (result.missingCallId) {
      console.warn("Skipping recording update because the call identifier was missing", {
        correlationId: ingress.correlationId,
        recordingId: ingress.event.recordingId?.value ?? null,
        recordingStatus: ingress.event.providerStatus,
      });
    } else if (!result.updated) {
      console.warn("Recording webhook did not match an existing lead", {
        correlationId: ingress.correlationId,
        callId: ingress.event.callId?.value ?? null,
        recordingId: ingress.event.recordingId?.value ?? null,
        recordingStatus: ingress.event.providerStatus,
      });
    } else if (result.matchedBy === "phone") {
      console.info("Recording webhook matched a recent lead by caller phone fallback", {
        correlationId: ingress.correlationId,
        callId: ingress.event.callId?.value ?? null,
        callerLast4: phoneLast4(ingress.event.from),
        recordingId: ingress.event.recordingId?.value ?? null,
      });
    }

    await markTooShortRecording({ account, event: ingress.event, leadId: result.leadId });
    if (
      account.voicemailTranscriptionEnabled &&
      result.leadId &&
      shouldAutoTranscribeRecording(ingress.event)
    ) {
      after(() => transcribeRecordingInBackground({
        ingress,
        account,
        xml,
        leadId: result.leadId,
      }));
    }

    await logWebhookEvent({
      accountId: account.accountId,
      source: RECORDING_WEBHOOK_SOURCE,
      correlationId: ingress.correlationId,
      payload: ingress.payload,
      responseStatus: 200,
      responseBody: xml,
      error: recordingEventNote({
        matchedUrl: ingress.validation.matchedUrl,
        recordingUpdated: result.updated,
        recordingMatchedBy: result.matchedBy,
        missingCallId: result.missingCallId,
      }),
      internalStatus: result.updated ? "succeeded" : "failed",
      providerStatus: result.updated ? "recording_attached" : "recording_unmatched",
      customerVisible: !result.updated,
    });

    if (!result.updated && !result.missingCallId) {
      await notifyAdminOperationalIssue({
        account,
        issue: "Recording did not attach to a lead",
        detail: `Call identifier ${ingress.event.callId?.value || "missing"} Recording identifier ${ingress.event.recordingId?.value || "missing"}`,
        correlationId: ingress.correlationId,
      });
    }
  } catch (error) {
    const message = errorMessage(error, "Unknown recording webhook error");
    await logWebhookEvent({
      accountId: account.accountId,
      source: RECORDING_WEBHOOK_SOURCE,
      correlationId: ingress.correlationId,
      payload: ingress.payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
      internalStatus: "failed",
      providerStatus: "local_processing_failed",
      customerVisible: true,
    });
    console.error("Failed to handle Twilio recording webhook", {
      correlationId: ingress.correlationId,
      ...ingress.requestSummary,
      error: message,
    });
    await notifyAdminOperationalIssue({
      account,
      issue: "Recording webhook failed",
      detail: message,
      correlationId: ingress.correlationId,
    });
  }

  return twimlResponse(xml);
}

function inboundMessageEventNote(input: {
  matchedUrl: string | null;
  action: InboundMessageAction;
}) {
  const notes = [];
  const validation = validationNote(input.matchedUrl);
  if (validation) notes.push(validation);
  const actionNotes: Record<InboundMessageAction, string> = {
    recorded_opt_out: "Recorded opt-out.",
    recorded_opt_in: "Recorded re-opt-in (START).",
    answered_help: "Answered HELP with business info.",
    notified_owner: "Notified owner by email.",
    forwarded_to_owner: "Forwarded inbound reply to owner.",
    ignored_empty_message: "Ignored because From or Body was missing.",
    ignored_owner_message: "Ignored because the sender is the account owner's phone.",
    duplicate_ignored: "Duplicate inbound SMS webhook ignored.",
  };
  notes.push(actionNotes[input.action]);
  return notes.join(" ");
}

export async function postTwilioInboundMessageWebhook(request: Request) {
  const ingress = await parseTwilioWebhook(request, "inbound_message");
  const message = inboundMessageIntent(ingress.event);
  const accountResolution = await resolveInboundMessageAccount(ingress.event);
  const resolvedAccount = accountResolution.status === "resolved"
    ? accountResolution.account
    : null;
  let responseXml = emptyTwiml();

  console.info("Twilio inbound SMS webhook received", {
    correlationId: ingress.correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...ingress.requestSummary,
    hasBody: Boolean(message.body),
    isOptOut: message.isOptOut,
    isOptIn: message.isOptIn,
    isHelp: message.isHelp,
  });

  if (ingress.validation.shouldReject) {
    return rejectSignature({
      ingress,
      accountId: resolvedAccount?.accountId ?? null,
      source: INBOUND_MESSAGE_WEBHOOK_SOURCE,
      label: "inbound SMS",
    });
  }
  if (ingress.validation.wasAllowedByOverride) {
    await logUnsignedTwilioWebhook({
      source: INBOUND_MESSAGE_WEBHOOK_SOURCE,
      accountId: resolvedAccount?.accountId ?? null,
      label: "inbound SMS",
      payload: ingress.payload,
      correlationId: ingress.correlationId,
      requestSummary: ingress.requestSummary,
      candidateUrls: ingress.validation.candidateUrls,
      hasSignature: ingress.validation.hasSignature,
      responseBody: "Allowed unsigned Twilio inbound SMS webhook by env override.",
    });
  }
  if (accountResolution.status === "unresolved") {
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: INBOUND_MESSAGE_WEBHOOK_SOURCE,
      label: "inbound SMS",
      payload: ingress.payload,
      correlationId: ingress.correlationId,
      responseBody: responseXml,
    });
  }

  const account = tenantAccount(accountResolution, "inbound message webhook");
  try {
    const action = await processInboundMessage({
      account,
      event: ingress.event,
      correlationId: ingress.correlationId,
    });
    responseXml = action === "answered_help"
      ? helpReplyTwiml({ businessName: account.businessName })
      : emptyTwiml();
    await logWebhookEvent({
      accountId: account.accountId,
      source: INBOUND_MESSAGE_WEBHOOK_SOURCE,
      correlationId: ingress.correlationId,
      payload: ingress.payload,
      responseStatus: 200,
      responseBody: responseXml,
      error: inboundMessageEventNote({
        matchedUrl: ingress.validation.matchedUrl,
        action,
      }),
    });
  } catch (error) {
    const message = errorMessage(error, "Unknown inbound SMS error");
    await logWebhookEvent({
      accountId: account.accountId,
      source: INBOUND_MESSAGE_WEBHOOK_SOURCE,
      correlationId: ingress.correlationId,
      payload: ingress.payload,
      responseStatus: 200,
      responseBody: responseXml,
      error: message,
      internalStatus: "failed",
      providerStatus: "local_processing_failed",
      customerVisible: true,
    });
    console.error("Failed to handle inbound Twilio SMS", {
      correlationId: ingress.correlationId,
      ...ingress.requestSummary,
      error: message,
    });
    await notifyAdminOperationalIssue({
      account,
      issue: "Inbound SMS handling failed",
      detail: message,
      correlationId: ingress.correlationId,
    });
  }

  return twimlResponse(responseXml);
}

function parseDeliveryCallbackContext(request: Request): DeliveryCallbackContext {
  const url = new URL(request.url);
  return {
    messageType: url.searchParams.get("messageType") === "manual_reply"
      ? "manual_reply"
      : "auto_text",
    accountId: url.searchParams.get("accountId")?.trim() || null,
    leadId: url.searchParams.get("leadId")?.trim() || null,
    actionKey: url.searchParams.get("actionKey")?.trim() || null,
  };
}

function messageDeliveryEventNote(input: {
  matchedUrl: string | null;
  event: MessageDeliveryUpdateEvent;
  leadUpdated: boolean;
  reconciledLeadId: string | null;
  callback: DeliveryCallbackContext;
}) {
  const notes = [];
  const validation = validationNote(input.matchedUrl);
  if (validation) notes.push(validation);
  if (input.event.messageId) notes.push(`Message identifier: ${input.event.messageId.value}`);
  if (input.event.providerStatus) notes.push(`Message status: ${input.event.providerStatus}`);
  if (input.callback.messageType === "manual_reply") {
    notes.push("Manual reply status updated on its message row.");
  } else if (input.reconciledLeadId) {
    notes.push(`Lead was stale after a partial failure; reconciled lead ${input.reconciledLeadId} via the messages table.`);
  } else if (!input.leadUpdated) {
    notes.push("No lead matched this message identifier.");
  }
  return notes.join(" ");
}

function deliveryFailureCode(event: MessageDeliveryUpdateEvent) {
  return event.error?.code?.match(/\b(?:21|30)\d{3}\b/)?.[0] ??
    event.error?.message?.match(/\b(?:21|30)\d{3}\b/)?.[0] ??
    null;
}

export async function postTwilioMessageDeliveryWebhook(request: Request) {
  const ingress = await parseTwilioWebhook(request, "message_delivery_updated");
  const callback = parseDeliveryCallbackContext(request);
  const accountResolution = await resolveMessageDeliveryAccount(ingress.event, callback);
  const resolvedAccount = accountResolution.status === "resolved"
    ? accountResolution.account
    : null;
  const xml = emptyTwiml();

  console.info("Twilio SMS status webhook received", {
    correlationId: ingress.correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...ingress.requestSummary,
    messageId: ingress.event.messageId?.value ?? null,
    messageStatus: ingress.event.providerStatus,
    messageType: callback.messageType,
  });

  if (ingress.validation.shouldReject) {
    return rejectSignature({
      ingress,
      accountId: resolvedAccount?.accountId ?? null,
      source: MESSAGE_DELIVERY_WEBHOOK_SOURCE,
      label: "SMS status",
    });
  }
  if (accountResolution.status === "unresolved") {
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: MESSAGE_DELIVERY_WEBHOOK_SOURCE,
      label: "SMS status",
      payload: ingress.payload,
      correlationId: ingress.correlationId,
      responseBody: xml,
    });
  }

  const account = tenantAccount(accountResolution, "message delivery webhook");
  try {
    const result = await processMessageDeliveryUpdate({
      account,
      event: ingress.event,
      callback,
      correlationId: ingress.correlationId,
    });
    if (result.reconciledLeadId) {
      console.warn("Reconciled stale lead SMS status from Twilio status callback", {
        correlationId: ingress.correlationId,
        leadId: result.reconciledLeadId,
        messageId: result.messageId,
        smsStatus: result.status,
      });
    }
    await logWebhookEvent({
      accountId: account.accountId,
      source: MESSAGE_DELIVERY_WEBHOOK_SOURCE,
      correlationId: ingress.correlationId,
      payload: ingress.payload,
      responseStatus: 200,
      responseBody: xml,
      error: messageDeliveryEventNote({
        matchedUrl: ingress.validation.matchedUrl,
        event: ingress.event,
        leadUpdated: result.leadUpdated,
        reconciledLeadId: result.reconciledLeadId,
        callback,
      }),
    });
  } catch (error) {
    const message = errorMessage(error, "Unknown SMS status error");
    await logWebhookEvent({
      accountId: account.accountId,
      source: MESSAGE_DELIVERY_WEBHOOK_SOURCE,
      correlationId: ingress.correlationId,
      payload: ingress.payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
      internalStatus: "failed",
      providerStatus: "local_processing_failed",
      failureCode: deliveryFailureCode(ingress.event),
      customerVisible: true,
    });
    console.error("Failed to handle Twilio SMS status", {
      correlationId: ingress.correlationId,
      ...ingress.requestSummary,
      error: message,
    });
  }

  return twimlResponse(xml);
}

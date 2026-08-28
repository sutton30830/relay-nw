function identifier(kind, value) {
  const normalized = String(value ?? "").trim();
  return normalized ? { provider: "twilio", kind, value: normalized } : null;
}

function number(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function callOutcome(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "no-answer") return "no_answer";
  if (["answered", "completed", "busy", "failed", "canceled"].includes(status)) return status;
  return "unknown";
}

function deliveryStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  return ["queued", "sending", "sent", "delivered", "failed", "undelivered"].includes(status)
    ? status
    : "unknown";
}

function canonicalEvent(type, payload) {
  const receivedAt = "2026-08-28T00:00:00.000Z";
  const base = {
    type,
    provider: "twilio",
    occurredAt: receivedAt,
    receivedAt,
    providerEventId: payload.EventSid || null,
  };
  if (type === "inbound_call") {
    return {
      ...base,
      callId: identifier("call", payload.CallSid),
      parentCallId: identifier("call", payload.ParentCallSid),
      from: String(payload.From ?? "").trim(),
      to: String(payload.To ?? "").trim(),
    };
  }
  if (type === "call_completed") {
    const providerStatus = String(payload.DialCallStatus ?? payload.CallStatus ?? "").trim().toLowerCase();
    return {
      ...base,
      callId: identifier("call", payload.CallSid),
      parentCallId: identifier("call", payload.ParentCallSid),
      from: String(payload.From ?? "").trim(),
      to: String(payload.To ?? "").trim(),
      outcome: callOutcome(providerStatus),
      durationSeconds: number(payload.DialCallDuration ?? payload.CallDuration),
      providerStatus: providerStatus || null,
    };
  }
  if (type === "recording_ready") {
    const providerStatus = String(payload.RecordingStatus ?? "").trim().toLowerCase();
    const rawUrl = String(payload.RecordingUrl ?? "").trim();
    return {
      ...base,
      recordingId: identifier("recording", payload.RecordingSid),
      callId: identifier("call", payload.CallSid),
      from: String(payload.From ?? "").trim(),
      to: String(payload.To ?? "").trim(),
      mediaUrl: rawUrl
        ? rawUrl.endsWith(".mp3") || rawUrl.endsWith(".wav") ? rawUrl : `${rawUrl}.mp3`
        : null,
      durationSeconds: number(payload.RecordingDuration),
      status: providerStatus === "completed"
        ? "ready"
        : providerStatus === "in-progress"
          ? "processing"
          : providerStatus === "failed" ? "failed" : "unknown",
      providerStatus: providerStatus || null,
    };
  }
  if (type === "inbound_message") {
    return {
      ...base,
      messageId: identifier("message", payload.MessageSid ?? payload.SmsSid),
      from: String(payload.From ?? "").trim(),
      to: String(payload.To ?? "").trim(),
      body: String(payload.Body ?? "").trim(),
      mediaCount: number(payload.NumMedia) ?? 0,
    };
  }
  const providerStatus = String(payload.MessageStatus ?? payload.SmsStatus ?? "").trim().toLowerCase();
  return {
    ...base,
    messageId: identifier("message", payload.MessageSid ?? payload.SmsSid),
    from: String(payload.From ?? "").trim(),
    to: String(payload.To ?? "").trim(),
    status: deliveryStatus(providerStatus),
    providerStatus: providerStatus || null,
    error: payload.ErrorCode || payload.ErrorMessage
      ? { code: String(payload.ErrorCode ?? "").trim() || null, message: String(payload.ErrorMessage ?? "").trim() || null }
      : null,
  };
}

function renderVoice(instructions, twiml) {
  const forward = instructions.find((instruction) => instruction.type === "forward_to_owner");
  if (forward) {
    const body = twiml.dialForwardTwiml
      ? twiml.dialForwardTwiml({
          ownerPhoneNumber: forward.ownerPhoneNumber,
          callerId: forward.callerId,
          actionUrl: forward.completionCallbackUrl,
          timeoutSeconds: forward.timeoutSeconds,
        })
      : `<Response><Dial>${forward.ownerPhoneNumber}</Dial></Response>`;
    return { body, status: 200, contentType: "text/xml; charset=utf-8" };
  }
  const greeting = instructions.find((instruction) => instruction.type === "play_greeting");
  const capture = instructions.find((instruction) => instruction.type === "capture_voicemail");
  if (greeting && capture) {
    const body = twiml.forwardedMissedCallTwiml
      ? twiml.forwardedMissedCallTwiml({
          message: greeting.greeting.type === "text" ? greeting.greeting.text : undefined,
          voiceName: greeting.greeting.type === "text" ? greeting.greeting.voice : undefined,
          greetingAudioUrl: greeting.greeting.type === "audio" ? greeting.greeting.url : undefined,
          recordingActionUrl: capture.completionCallbackUrl,
          maxLengthSeconds: capture.maxDurationSeconds,
        })
      : "<Response><Say>greeting</Say><Record /></Response>";
    return { body, status: 200, contentType: "text/xml; charset=utf-8" };
  }
  const reject = instructions.find((instruction) => instruction.type === "reject_safely");
  return {
    body: `<Response><Say>${reject?.message ?? "Unavailable"}</Say><Hangup /></Response>`,
    status: 200,
    contentType: "text/xml; charset=utf-8",
  };
}

export async function loadWebhookHandlers(loadTsModule, mocks) {
  const env = mocks["@/lib/env"] ?? { env: {} };
  const phone = mocks["@/lib/phone"] ?? {
    normalizePhoneNumber: (value) => String(value ?? "").trim(),
    phoneLast4: (value) => String(value ?? "").replace(/\D/g, "").slice(-4) || null,
  };
  const emails = mocks["@/lib/email"] ?? {};
  const legacySupabase = mocks["@/lib/supabase"] ?? {};
  const supabase = {
    ...legacySupabase,
    resolveAccountByProviderCallId:
      legacySupabase.resolveAccountByProviderCallId ?? legacySupabase.resolveAccountByCallSid,
    resolveAccountByProviderMessageId:
      legacySupabase.resolveAccountByProviderMessageId ?? legacySupabase.resolveAccountByMessageSid,
    resolveAccountByRelayPhoneNumber:
      legacySupabase.resolveAccountByRelayPhoneNumber ?? legacySupabase.resolveAccountByTwilioNumber,
    getOutboundMessageLeadIdByProviderId: legacySupabase.getOutboundMessageLeadIdByProviderId ??
      (legacySupabase.getOutboundMessageLeadIdBySid
        ? (input) => legacySupabase.getOutboundMessageLeadIdBySid({
            ...input,
            twilioMessageSid: input.providerMessageId,
          })
        : undefined),
    updateLeadSmsStatusByProviderMessageId: legacySupabase.updateLeadSmsStatusByProviderMessageId ??
      (legacySupabase.updateLeadSmsStatusByMessageSid
        ? (input) => legacySupabase.updateLeadSmsStatusByMessageSid({
            ...input,
            twilioMessageSid: input.providerMessageId,
          })
        : undefined),
    updateMessageStatusByProviderMessageId: legacySupabase.updateMessageStatusByProviderMessageId ??
      (legacySupabase.updateMessageStatusBySid
        ? (input) => legacySupabase.updateMessageStatusBySid({
            ...input,
            twilioMessageSid: input.providerMessageId,
          })
        : undefined),
    updateCallRecordingByProviderCallId: legacySupabase.updateCallRecordingByProviderCallId ??
      (legacySupabase.updateCallRecordingByCallSid
        ? (input) => legacySupabase.updateCallRecordingByCallSid({
            ...input,
            callSid: input.providerCallId,
            recordingSid: input.providerRecordingId,
          })
        : undefined),
    updateLeadRecordingByProviderCallId: legacySupabase.updateLeadRecordingByProviderCallId ??
      (legacySupabase.updateLeadRecordingByCallSid
        ? (input) => legacySupabase.updateLeadRecordingByCallSid({
            ...input,
            callSid: input.providerCallId,
            recordingSid: input.providerRecordingId,
          })
        : undefined),
    upsertCall: legacySupabase.upsertCall
      ? (input) => legacySupabase.upsertCall({
          ...input,
          callSid: input.providerCallId,
          parentCallSid: input.parentProviderCallId,
        })
      : undefined,
    createInboundMessageIfNew: legacySupabase.createInboundMessageIfNew
      ? (input) => legacySupabase.createInboundMessageIfNew({
          ...input,
          messageSid: input.providerMessageId,
        })
      : undefined,
    createMessageIfNew: legacySupabase.createMessageIfNew
      ? (input) => legacySupabase.createMessageIfNew({
          ...input,
          twilioMessageSid: input.providerMessageId,
        })
      : undefined,
    updateLeadSmsStatus: legacySupabase.updateLeadSmsStatus
      ? (input) => legacySupabase.updateLeadSmsStatus({
          ...input,
          twilioMessageSid: input.providerMessageId,
        })
      : undefined,
  };
  const originalRegistry = mocks["@/lib/telephony/registry"];
  const originalTwilio = mocks["@/lib/twilio"] ?? {};
  const twiml = mocks["@/lib/twiml"] ?? {
    emptyTwiml: () => "<Response></Response>",
    helpReplyTwiml: ({ businessName }) => `<Response><Message>${businessName}</Message></Response>`,
    twimlResponse: (body) => new Response(body, { status: 200, headers: { "content-type": "text/xml" } }),
  };
  const provider = {
    identity: { id: "twilio", displayName: "Twilio" },
    renderVoiceInstructions: (instructions) => renderVoice(instructions, twiml),
  };

  const serviceMocks = {
    "@/lib/billing-activation": mocks["@/lib/billing-activation"] ?? { activateStripeTrialForAccount: async () => {} },
    "@/lib/email": {
      notifyOwnerInboundReply: async () => {},
      notifyOwnerOptOut: async () => {},
      ...emails,
    },
    "@/lib/env": env,
    "@/lib/missed-call": mocks["@/lib/missed-call"]
      ? {
          ...mocks["@/lib/missed-call"],
          handleMissedCall: (input) => mocks["@/lib/missed-call"].handleMissedCall({
            ...input,
            callSid: input.providerCallId,
            twilioSignatureValid: input.providerSignatureValid,
          }),
        }
      : { handleMissedCall: async () => ({ smsStatus: null, becameLive: false }) },
    "@/lib/phone": phone,
    "@/lib/telephony/owner-sms": mocks["@/lib/telephony/owner-sms"] ?? {
      sendOwnerSms: async (input) => {
        if (typeof originalTwilio.sendOwnerSms === "function") return originalTwilio.sendOwnerSms(input);
        const outboundProvider = originalRegistry?.getTelephonyProvider?.();
        if (!outboundProvider?.sendSms) return;
        return outboundProvider.sendSms({
          from: input.account.twilioPhoneNumber,
          to: input.account.ownerPhoneNumber,
          body: input.body,
          idempotencyKey: input.actionKey,
          deliveryCallback: null,
        });
      },
    },
    "@/lib/supabase": supabase,
    "@/lib/voicemail-ai": mocks["@/lib/voicemail-ai"] ?? {
      isExpectedVoicemailQualityErrorMessage: () => false,
      transcribeLeadVoicemail: async () => {},
    },
    "@/lib/voicemail-quality": mocks["@/lib/voicemail-quality"] ?? {
      NO_USABLE_VOICEMAIL_MESSAGE: "No usable voicemail was recorded.",
      recordingIsTooShort: (duration) => duration !== null && duration < 3,
    },
  };
  const services = await loadTsModule("lib/telephony/webhook-services.ts", serviceMocks);
  const twilioIngress = {
    ...originalTwilio,
    parseTwilioWebhook: async (request, type) => {
      const formData = await request.formData();
      const payload = originalTwilio.formDataToRecord
        ? originalTwilio.formDataToRecord(formData)
        : Object.fromEntries(formData.entries());
      const validation = originalTwilio.validateTwilioWebhook
        ? originalTwilio.validateTwilioWebhook(request, payload)
        : {
            shouldReject: false,
            wasAllowedByOverride: false,
            matchedUrl: request.url,
            candidateUrls: [request.url],
            hasSignature: true,
          };
      return {
        event: canonicalEvent(type, payload),
        payload,
        correlationId: payload.CallSid || payload.MessageSid || payload.RecordingSid || "test-correlation",
        requestSummary: originalTwilio.summarizeTwilioRequest?.(request, payload) ?? {},
        validation,
      };
    },
    logUnsignedTwilioWebhook: originalTwilio.logUnsignedTwilioWebhook ?? (async () => {}),
    rejectInvalidTwilioSignature: originalTwilio.rejectInvalidTwilioSignature ?? (() => new Response("Forbidden", { status: 403 })),
  };
  const controllerMocks = {
    "next/server": mocks["next/server"] ?? { after: (callback) => void callback() },
    "@/lib/email": { notifyAdminOperationalIssue: async () => {}, ...emails },
    "@/lib/env": env,
    "@/lib/phone": phone,
    "@/lib/telephony/registry": { getTelephonyProvider: () => provider },
    "@/lib/telephony/webhook-services": services,
    "@/lib/supabase": supabase,
    "@/lib/twilio": twilioIngress,
    "@/lib/twilio/unresolved-account": mocks["@/lib/twilio/unresolved-account"] ?? {
      handleUnresolvedTwilioAccount: (input) => new Response(input.responseBody ?? "", { status: 200 }),
    },
    "@/lib/twiml": twiml,
  };

  return loadTsModule("lib/telephony/providers/twilio-webhooks.ts", controllerMocks);
}

export async function loadWebhookRoute(loadTsModule, routePath, mocks) {
  const handlers = await loadWebhookHandlers(loadTsModule, mocks);
  return loadTsModule(routePath, {
    "@/lib/telephony/providers/twilio-webhooks": handlers,
  });
}

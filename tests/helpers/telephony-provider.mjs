function deliveryStatus(value) {
  const normalized = String(value ?? "").toLowerCase();
  return ["queued", "sending", "sent", "delivered", "failed", "undelivered"].includes(normalized)
    ? normalized
    : "unknown";
}

function callbackUrl(input) {
  if (!input.deliveryCallback) return undefined;
  const url = new URL(input.deliveryCallback.url);
  for (const [key, value] of Object.entries(input.deliveryCallback.metadata)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function telephonyProviderMock(options = {}) {
  const provider = {
    identity: { id: "twilio", displayName: "Twilio" },
    async sendSms(input) {
      if (options.sendSms) return options.sendSms(input);
      if (!options.twilioClient?.messages?.create) {
        throw new Error("Test telephony provider has no SMS implementation");
      }
      const statusCallback = callbackUrl(input);
      const message = await options.twilioClient.messages.create({
        from: input.from,
        to: input.to,
        body: input.body,
        ...(statusCallback ? { statusCallback } : {}),
      });
      return {
        messageId: { provider: "twilio", kind: "message", value: message.sid },
        status: deliveryStatus(message.status),
        idempotencyKey: input.idempotencyKey,
      };
    },
    async fetchRecordingAudio(identifier) {
      if (options.fetchRecordingAudio) return options.fetchRecordingAudio(identifier);
      throw new Error("Test telephony provider has no recording implementation");
    },
    async configureNumber(input) {
      if (options.configureNumber) return options.configureNumber(input);
      throw new Error("Test telephony provider has no number configuration implementation");
    },
    async readMessagingRegistrationEvidence(input) {
      if (options.readMessagingRegistrationEvidence) {
        return options.readMessagingRegistrationEvidence(input);
      }
      throw new Error("Test telephony provider has no registration implementation");
    },
    async deleteResource(identifier) {
      if (options.deleteResource) return options.deleteResource(identifier);
      return "deleted";
    },
  };

  return {
    provider,
    registry: { getTelephonyProvider: () => provider },
  };
}

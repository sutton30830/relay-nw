function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function twimlResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
}

export function dialForwardTwiml(input: {
  ownerPhoneNumber: string;
  callerId: string;
  actionUrl: string;
  timeoutSeconds: number;
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${input.timeoutSeconds}" action="${escapeXml(input.actionUrl)}" method="POST" callerId="${escapeXml(input.callerId)}">
    <Number>${escapeXml(input.ownerPhoneNumber)}</Number>
  </Dial>
</Response>`;
}

export function emptyTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`;
}

export function helpReplyTwiml(input: { businessName: string }) {
  const body = `${input.businessName} via Relay NW: we text you back when we miss your call. Msg&data rates may apply. Msg frequency varies. Reply STOP to opt out.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(body)}</Message>
</Response>`;
}

const defaultForwardingMessage =
  "Thanks for calling. Sorry we missed you. We will text you shortly. Please leave a quick recorded message after the tone.";

export function forwardedMissedCallTwiml(input: {
  message?: string;
  voiceName?: string;
  greetingAudioUrl?: string;
  recordingActionUrl: string;
  maxLengthSeconds?: number;
}) {
  const greeting = input.greetingAudioUrl
    ? `  <Play>${escapeXml(input.greetingAudioUrl)}</Play>`
    : `  <Say voice="${escapeXml(input.voiceName ?? "Polly.Joanna-Neural")}">${escapeXml(input.message ?? defaultForwardingMessage)}</Say>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${greeting}
  <Record action="${escapeXml(input.recordingActionUrl)}" method="POST" recordingStatusCallback="${escapeXml(input.recordingActionUrl)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed" maxLength="${input.maxLengthSeconds ?? 60}" playBeep="true" timeout="5" trim="trim-silence" />
</Response>`;
}

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

const defaultForwardingMessage =
  "Thanks for calling. Sorry we missed you. We will text you shortly so we can help.";

export function forwardedMissedCallTwiml(
  message = defaultForwardingMessage,
  voiceName = "Polly.Joanna-Neural",
) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(voiceName)}">${escapeXml(message)}</Say>
  <Hangup />
</Response>`;
}

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
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="${escapeXml(input.actionUrl)}" method="POST" callerId="${escapeXml(input.callerId)}">
    <Number>${escapeXml(input.ownerPhoneNumber)}</Number>
  </Dial>
</Response>`;
}

export function emptyTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`;
}

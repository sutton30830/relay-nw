import { twimlResponse } from "@/lib/twiml";

export async function GET() {
  return twimlResponse(healthCheckOutboundTwiml());
}

export async function POST() {
  return twimlResponse(healthCheckOutboundTwiml());
}

function healthCheckOutboundTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Relay forwarding health check. Please do not answer this test call.</Say>
  <Pause length="1" />
</Response>`;
}

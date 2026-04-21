import { env } from "@/lib/env";
import { dialForwardTwiml, twimlResponse } from "@/lib/twiml";

export async function POST(request: Request) {
  const formData = await request.formData();
  const forwardedFrom = String(formData.get("To") || env.twilioPhoneNumber);
  const url = new URL(request.url);
  const actionUrl = new URL("/api/twilio/dial-status", url.origin).toString();

  const xml = dialForwardTwiml({
    ownerPhoneNumber: env.ownerPhoneNumber,
    callerId: forwardedFrom,
    actionUrl,
  });

  return twimlResponse(xml);
}

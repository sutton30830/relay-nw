import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ recordingSid: string }> },
) {
  const cookieStore = await cookies();
  const isAllowed = isValidLeadsSessionCookie(cookieStore.get(LEADS_COOKIE_NAME)?.value);

  if (!isAllowed) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { recordingSid } = await params;

  if (!/^RE[a-fA-F0-9]{32}$/.test(recordingSid)) {
    return new Response("Invalid recording", { status: 400 });
  }

  const recordingUrl =
    `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Recordings/${recordingSid}.mp3`;
  const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");
  const recordingResponse = await fetch(recordingUrl, {
    headers: {
      Authorization: `Basic ${auth}`,
    },
    cache: "no-store",
  });

  if (!recordingResponse.ok || !recordingResponse.body) {
    return new Response("Recording unavailable", { status: recordingResponse.status });
  }

  return new Response(recordingResponse.body, {
    status: 200,
    headers: {
      "Content-Type": recordingResponse.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "private, no-store",
    },
  });
}

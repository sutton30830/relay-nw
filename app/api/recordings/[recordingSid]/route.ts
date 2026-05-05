import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";
import { recordingBelongsToLead } from "@/lib/supabase";

const PRIVATE_AUDIO_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

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

  const isKnownRecording = await recordingBelongsToLead(recordingSid);
  if (!isKnownRecording) {
    return new Response("Recording unavailable", {
      status: 404,
      headers: PRIVATE_AUDIO_HEADERS,
    });
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
    return new Response("Recording unavailable", {
      status: recordingResponse.status,
      headers: PRIVATE_AUDIO_HEADERS,
    });
  }

  return new Response(recordingResponse.body, {
    status: 200,
    headers: {
      ...PRIVATE_AUDIO_HEADERS,
      "Content-Type": recordingResponse.headers.get("content-type") ?? "audio/mpeg",
    },
  });
}

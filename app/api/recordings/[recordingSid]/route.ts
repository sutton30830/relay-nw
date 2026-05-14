import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";
import { getLeadRecordingForPlayback } from "@/lib/supabase";

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
  const leadsCookie = cookieStore.get(LEADS_COOKIE_NAME)?.value;
  const isAllowed = isValidLeadsSessionCookie(leadsCookie);

  if (!isAllowed) {
    console.warn("Recording request blocked", {
      reason: leadsCookie ? "invalid_leads_session" : "missing_leads_session",
    });
    return new Response("Unauthorized", { status: 401 });
  }

  const { recordingSid } = await params;

  if (!/^RE[a-fA-F0-9]{32}$/.test(recordingSid)) {
    return new Response("Invalid recording", { status: 400 });
  }

  const recording = await getLeadRecordingForPlayback(recordingSid);
  if (!recording) {
    console.warn("Recording request blocked", {
      reason: "recording_not_linked_to_lead",
      recordingSid,
    });
    return new Response("Recording unavailable", {
      status: 404,
      headers: PRIVATE_AUDIO_HEADERS,
    });
  }

  const recordingUrl =
    recording.recording_url
    ?? `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Recordings/${recordingSid}.mp3`;
  const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");
  const recordingResponse = await fetch(recordingUrl, {
    headers: {
      Authorization: `Basic ${auth}`,
    },
    cache: "no-store",
  });

  if (!recordingResponse.ok || !recordingResponse.body) {
    console.warn("Twilio recording fetch failed", {
      recordingSid,
      status: recordingResponse.status,
    });
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

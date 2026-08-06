import { env } from "@/lib/env";
import { requireAccountUserJson } from "@/lib/auth";
import { getLeadRecordingForPlayback, recordProviderAction } from "@/lib/supabase";
import { isTrustedTwilioMediaUrl } from "@/lib/twilio";

const PRIVATE_AUDIO_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ recordingSid: string }> },
) {
  const auth = await requireAccountUserJson();
  if (auth.response) return new Response("Unauthorized", { status: 401 });

  const { recordingSid } = await params;

  if (!/^RE[a-fA-F0-9]{32}$/.test(recordingSid)) {
    return new Response("Invalid recording", { status: 400 });
  }

  const recording = await getLeadRecordingForPlayback(recordingSid, auth.session.accountId);
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

  const storedUrl = recording.recording_url;
  const isTrustedStoredUrl = isTrustedTwilioMediaUrl(storedUrl);
  const recordingUrl = isTrustedStoredUrl
    ? storedUrl!
    : `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Recordings/${recordingSid}.mp3`;

  if (storedUrl && !isTrustedStoredUrl) {
    console.warn("Stored recording_url rejected by allowlist", { recordingSid });
  }

  const actionKey = `recording_retrieval:${recordingSid}`;
  const recordRetrieval = (input: Parameters<typeof recordProviderAction>[0]) => {
    if (typeof recordProviderAction !== "function") return Promise.resolve();
    return recordProviderAction(input).catch((actionError) => {
      console.error("Recording retrieval evidence failed", { recordingSid, actionError });
    });
  };

  await recordRetrieval({
    accountId: auth.session.accountId,
    action: "recording_retrieval",
    provider: "twilio",
    idempotencyKey: actionKey,
    providerIdentifier: recordingSid,
    resourceType: "lead",
    resourceId: recording.id,
    internalStatus: "processing",
    providerStatus: "fetching",
    customerExplanation: "Relay is loading the recording.",
    retryEligibility: "automatic",
    recommendedNextAction: "Wait for playback to begin.",
    customerVisible: false,
    countAttempt: true,
  });

  const twilioAuth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");
  let recordingResponse: Response;
  try {
    recordingResponse = await fetch(recordingUrl, {
      headers: {
        Authorization: `Basic ${twilioAuth}`,
      },
      cache: "no-store",
    });
  } catch (error) {
    await recordRetrieval({
      accountId: auth.session.accountId,
      action: "recording_retrieval",
      provider: "twilio",
      idempotencyKey: actionKey,
      providerIdentifier: recordingSid,
      resourceType: "lead",
      resourceId: recording.id,
      internalStatus: "failed",
      providerStatus: "request_failed",
      diagnosticDetail: error,
      customerExplanation: "The recording is temporarily unavailable.",
      retryEligibility: "automatic",
      recommendedNextAction: "Try playback again in a moment.",
      customerVisible: true,
    });
    return new Response("Recording unavailable", { status: 503, headers: PRIVATE_AUDIO_HEADERS });
  }

  if (!recordingResponse.ok || !recordingResponse.body) {
    console.warn("Twilio recording fetch failed", {
      recordingSid,
      status: recordingResponse.status,
    });
    await recordRetrieval({
      accountId: auth.session.accountId,
      action: "recording_retrieval",
      provider: "twilio",
      idempotencyKey: actionKey,
      providerIdentifier: recordingSid,
      resourceType: "lead",
      resourceId: recording.id,
      internalStatus: "failed",
      providerStatus: String(recordingResponse.status),
      failureCode: String(recordingResponse.status),
      customerExplanation: recordingResponse.status === 404
        ? "This recording is no longer available from the phone provider."
        : "The recording is temporarily unavailable.",
      retryEligibility: recordingResponse.status === 404 ? "never" : "automatic",
      recommendedNextAction: recordingResponse.status === 404
        ? "Use the call details to contact the caller directly."
        : "Try playback again in a moment.",
      customerVisible: true,
    });
    return new Response("Recording unavailable", {
      status: recordingResponse.status,
      headers: PRIVATE_AUDIO_HEADERS,
    });
  }

  await recordRetrieval({
    accountId: auth.session.accountId,
    action: "recording_retrieval",
    provider: "twilio",
    idempotencyKey: actionKey,
    providerIdentifier: recordingSid,
    resourceType: "lead",
    resourceId: recording.id,
    internalStatus: "succeeded",
    providerStatus: "streaming",
    customerExplanation: "The recording is available.",
    retryEligibility: "never",
    recommendedNextAction: "No action is needed.",
    customerVisible: false,
  });

  return new Response(recordingResponse.body, {
    status: 200,
    headers: {
      ...PRIVATE_AUDIO_HEADERS,
      "Content-Type": recordingResponse.headers.get("content-type") ?? "audio/mpeg",
    },
  });
}

import { requireAccountUserJson } from "@/lib/auth";
import { getLeadRecordingForPlayback, recordProviderAction } from "@/lib/supabase";
import { getTelephonyProvider } from "@/lib/telephony/registry";

const PRIVATE_AUDIO_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function providerErrorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ recordingSid: string }> },
) {
  const auth = await requireAccountUserJson();
  if (auth.response) return new Response("Unauthorized", { status: 401 });

  const { recordingSid: providerRecordingId } = await params;

  // Current persisted recording IDs are legacy Twilio SIDs. Keep their existing
  // validation until additive provider-resource columns are introduced.
  if (!/^RE[a-fA-F0-9]{32}$/.test(providerRecordingId)) {
    return new Response("Invalid recording", { status: 400 });
  }

  const recording = await getLeadRecordingForPlayback(
    providerRecordingId,
    auth.session.accountId,
  );
  if (!recording) {
    console.warn("Recording request blocked", {
      reason: "recording_not_linked_to_lead",
      providerRecordingId,
    });
    return new Response("Recording unavailable", {
      status: 404,
      headers: PRIVATE_AUDIO_HEADERS,
    });
  }

  const provider = getTelephonyProvider();

  const actionKey = `recording_retrieval:${providerRecordingId}`;
  const recordRetrieval = (input: Parameters<typeof recordProviderAction>[0]) => {
    if (typeof recordProviderAction !== "function") return Promise.resolve();
    return recordProviderAction(input).catch((actionError) => {
      console.error("Recording retrieval evidence failed", { providerRecordingId, actionError });
    });
  };

  await recordRetrieval({
    accountId: auth.session.accountId,
    action: "recording_retrieval",
    provider: provider.identity.id,
    idempotencyKey: actionKey,
    providerIdentifier: providerRecordingId,
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

  let recordingAudio: Awaited<ReturnType<typeof provider.fetchRecordingAudio>>;
  try {
    recordingAudio = await provider.fetchRecordingAudio({
      provider: provider.identity.id,
      kind: "recording",
      value: providerRecordingId,
    });
  } catch (error) {
    const providerStatus = providerErrorStatus(error);
    const responseStatus = providerStatus && providerStatus >= 400 && providerStatus <= 599
      ? providerStatus
      : 503;
    await recordRetrieval({
      accountId: auth.session.accountId,
      action: "recording_retrieval",
      provider: provider.identity.id,
      idempotencyKey: actionKey,
      providerIdentifier: providerRecordingId,
      resourceType: "lead",
      resourceId: recording.id,
      internalStatus: "failed",
      providerStatus: providerStatus ? String(providerStatus) : "request_failed",
      failureCode: providerStatus ? String(providerStatus) : null,
      diagnosticDetail: error,
      customerExplanation: providerStatus === 404
        ? "This recording is no longer available from the phone provider."
        : "The recording is temporarily unavailable.",
      retryEligibility: providerStatus === 404 ? "never" : "automatic",
      recommendedNextAction: providerStatus === 404
        ? "Use the call details to contact the caller directly."
        : "Try playback again in a moment.",
      customerVisible: true,
    });
    return new Response("Recording unavailable", {
      status: responseStatus,
      headers: PRIVATE_AUDIO_HEADERS,
    });
  }

  await recordRetrieval({
    accountId: auth.session.accountId,
    action: "recording_retrieval",
    provider: provider.identity.id,
    idempotencyKey: actionKey,
    providerIdentifier: providerRecordingId,
    resourceType: "lead",
    resourceId: recording.id,
    internalStatus: "succeeded",
    providerStatus: "streaming",
    customerExplanation: "The recording is available.",
    retryEligibility: "never",
    recommendedNextAction: "No action is needed.",
    customerVisible: false,
  });

  return new Response(recordingAudio.audio, {
    status: 200,
    headers: {
      ...PRIVATE_AUDIO_HEADERS,
      "Content-Type": recordingAudio.contentType ?? "audio/mpeg",
    },
  });
}

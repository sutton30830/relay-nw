import { requireWriteAccessJson } from "@/lib/auth";
import {
  isExpectedVoicemailQualityErrorMessage,
  transcribeLeadVoicemail,
} from "@/lib/voicemail-ai";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWriteAccessJson();
  if (auth.response) return auth.response;

  const { id } = await params;

  try {
    const result = await transcribeLeadVoicemail(id, auth.session.accountId);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to summarize voicemail.";
    const isExpectedQualityOutcome = isExpectedVoicemailQualityErrorMessage(message);

    const log = isExpectedQualityOutcome ? console.info : console.error;
    log("Failed to summarize voicemail", {
      leadId: id,
      error: message,
    });

    return Response.json(
      { error: message },
      { status: isExpectedQualityOutcome ? 422 : 500 },
    );
  }
}

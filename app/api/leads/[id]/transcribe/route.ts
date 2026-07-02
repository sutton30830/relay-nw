import { requireWriteAccessJson } from "@/lib/auth";
import { transcribeLeadVoicemail } from "@/lib/voicemail-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

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

    console.error("Failed to summarize voicemail", {
      leadId: id,
      error: message,
    });

    return Response.json({ error: message }, { status: 500 });
  }
}

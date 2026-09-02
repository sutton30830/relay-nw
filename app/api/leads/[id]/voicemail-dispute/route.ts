import { requireWriteAccessJson } from "@/lib/auth";
import { disputeLeadVoicemailTranscript } from "@/lib/voicemail-dispute";

export const runtime = "nodejs";

// The owner says the transcript is wrong. No request body: the decision is
// binary and scoped to the lead in the URL and the account in the session.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWriteAccessJson("Viewers cannot change voicemail transcripts");
  if (auth.response) return auth.response;

  const { id } = await params;

  try {
    const result = await disputeLeadVoicemailTranscript({
      leadId: id,
      accountId: auth.session.accountId,
      actorEmail: auth.session.email,
    });

    if (result.outcome === "not_found") {
      return Response.json({ error: "Lead not found" }, { status: 404 });
    }
    if (result.outcome === "no_recording") {
      return Response.json({ error: "This lead has no voicemail recording." }, { status: 400 });
    }

    return Response.json({ ok: true, outcome: result.outcome });
  } catch (error) {
    console.error("Failed to record voicemail transcript dispute", { leadId: id, error });
    return Response.json({ error: "Could not hide this transcript. Try again." }, { status: 500 });
  }
}

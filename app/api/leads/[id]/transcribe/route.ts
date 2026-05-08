import { cookies } from "next/headers";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";
import { transcribeLeadVoicemail } from "@/lib/voicemail-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

async function isAuthorized() {
  const cookieStore = await cookies();
  return isValidLeadsSessionCookie(cookieStore.get(LEADS_COOKIE_NAME)?.value);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthorized())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const result = await transcribeLeadVoicemail(id);
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

import { twilioClient } from "@/lib/twilio";
import { isAuthorizedSmsTestRequest } from "../_auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthorizedSmsTestRequest())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const messageSid = url.searchParams.get("messageSid")?.trim();

  if (!messageSid) {
    return Response.json({ error: "Missing messageSid." }, { status: 400 });
  }

  try {
    const message = await twilioClient.messages(messageSid).fetch();

    return Response.json(
      {
        messageSid: message.sid,
        status: message.status,
        errorCode: message.errorCode,
        errorMessage: message.errorMessage,
        dateUpdated: message.dateUpdated?.toISOString() ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown SMS status error";

    return Response.json(
      { error: "Unable to load SMS test status.", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

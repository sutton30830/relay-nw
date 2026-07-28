import { requireWriteAccessJson } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  createMessageIfNew,
  getLeadByIdForAccount,
  isOptedOut,
  updateLead,
} from "@/lib/supabase";
import { phoneLast4, twilioClient } from "@/lib/twilio";

// Four GSM-7 segments. Long enough for a real reply, short enough to stay conversational.
const MAX_REPLY_LENGTH = 640;

type ReplyBody = {
  body?: unknown;
};

async function readReplyBody(request: Request): Promise<string | { error: string }> {
  let parsed: ReplyBody | null;

  try {
    parsed = (await request.json()) as ReplyBody;
  } catch {
    return { error: "Invalid request body" };
  }

  if (!parsed || typeof parsed.body !== "string") {
    return { error: "Reply text is required" };
  }

  const body = parsed.body.trim();

  if (!body) {
    return { error: "Reply text is required" };
  }

  if (body.length > MAX_REPLY_LENGTH) {
    return { error: `Reply is too long (max ${MAX_REPLY_LENGTH} characters)` };
  }

  return body;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWriteAccessJson("Viewers cannot send replies");
  if (auth.response) return auth.response;

  const { session } = auth;

  const { id } = await params;
  const body = await readReplyBody(request);

  if (typeof body !== "string") {
    return Response.json({ error: body.error }, { status: 400 });
  }

  const account = session.account;
  const accountId = session.accountId;

  if (!account.smsEnabled) {
    return Response.json(
      { error: "Texting is not enabled for this account yet." },
      { status: 400 },
    );
  }

  let lead: Awaited<ReturnType<typeof getLeadByIdForAccount>>;

  try {
    lead = await getLeadByIdForAccount(accountId, id);
  } catch (error) {
    console.error("Reply failed: could not load lead", { leadId: id, error });
    return Response.json({ error: "Unable to load this lead" }, { status: 500 });
  }

  if (!lead || lead.deleted_at) {
    return Response.json({ error: "Lead not found" }, { status: 404 });
  }

  // Fail closed: if the opt-out check cannot be completed, do not send.
  let optedOut: boolean;

  try {
    optedOut = await isOptedOut(lead.phone, accountId);
  } catch (error) {
    console.error("Reply failed: could not verify opt-out status; failing closed", {
      leadId: id,
      callerLast4: phoneLast4(lead.phone),
      error,
    });
    return Response.json(
      { error: "Could not verify opt-out status. Reply not sent." },
      { status: 500 },
    );
  }

  if (optedOut) {
    return Response.json(
      { error: "This customer has opted out of texting. Call them instead." },
      { status: 403 },
    );
  }

  let messageSid: string;
  let initialStatus = "queued";

  try {
    const statusCallback = new URL("/api/twilio/sms-status", env.appBaseUrl);
    statusCallback.searchParams.set("messageType", "manual_reply");
    statusCallback.searchParams.set("accountId", accountId);

    const message = await twilioClient.messages.create({
      to: lead.phone,
      from: account.twilioPhoneNumber,
      body,
      statusCallback: statusCallback.toString(),
    });
    messageSid = message.sid;
    initialStatus = message.status || initialStatus;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown SMS send error";
    console.error("Reply SMS send failed", {
      leadId: id,
      callerLast4: phoneLast4(lead.phone),
      error: detail,
    });
    return Response.json({ error: "Twilio could not send the reply. Try again." }, { status: 502 });
  }

  const sentAt = new Date().toISOString();

  // Twilio accepted the message past this point; recording failures must not fail the request.
  try {
    await createMessageIfNew({
      accountId,
      leadId: lead.id,
      twilioMessageSid: messageSid,
      direction: "outbound",
      fromPhone: account.twilioPhoneNumber,
      toPhone: lead.phone,
      body,
      status: initialStatus,
    });
  } catch (error) {
    console.error("Twilio accepted reply, but Relay could not record the message row", {
      leadId: id,
      twilioMessageSid: messageSid,
      error: error instanceof Error ? error.message : error,
    });
  }

  if (lead.status === "new") {
    try {
      await updateLead({ accountId, id: lead.id, status: "contacted" });
    } catch (error) {
      console.error("Reply sent, but could not mark lead as contacted", {
        leadId: id,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  console.info("Owner reply sent from Relay number", {
    leadId: id,
    twilioMessageSid: messageSid,
    callerLast4: phoneLast4(lead.phone),
  });

  return Response.json({
    ok: true,
    message: {
      id: messageSid,
      lead_id: lead.id,
      twilio_message_sid: messageSid,
      from_phone: account.twilioPhoneNumber,
      to_phone: lead.phone,
      body,
      status: initialStatus,
      error: null,
      created_at: sentAt,
      updated_at: sentAt,
    },
  });
}

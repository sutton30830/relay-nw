import { requireWriteAccessJson } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  createMessageIfNew,
  claimProviderActionRetry,
  getProviderActionByKey,
  getLeadByIdForAccount,
  isOptedOut,
  recordProviderAction,
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
  const requestIdempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";

  if (typeof body !== "string") {
    return Response.json({ error: body.error }, { status: 400 });
  }

  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(requestIdempotencyKey)) {
    return Response.json({ error: "A valid Idempotency-Key is required" }, { status: 400 });
  }

  const account = session.account;
  const accountId = session.accountId;
  const actionKey = `manual_reply:${id}:${requestIdempotencyKey}`;

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
    if (typeof recordProviderAction === "function") {
      await recordProviderAction({
        accountId,
        action: "manual_reply_sms",
        provider: "relay",
        idempotencyKey: actionKey,
        resourceType: "lead",
        resourceId: id,
        internalStatus: "suppressed",
        providerStatus: "opted_out",
        customerExplanation: "This customer opted out of texting, so Relay did not send the reply.",
        retryEligibility: "never",
        recommendedNextAction: "Call the customer instead.",
        customerVisible: true,
        expectedSuppression: true,
      });
    }
    return Response.json(
      { error: "This customer has opted out of texting. Call them instead." },
      { status: 403 },
    );
  }

  let messageSid: string;
  let initialStatus = "queued";

  if (
    typeof recordProviderAction === "function"
    && typeof claimProviderActionRetry === "function"
  ) {
    try {
      await recordProviderAction({
        accountId,
        action: "manual_reply_sms",
        provider: "twilio",
        idempotencyKey: actionKey,
        resourceType: "lead",
        resourceId: lead.id,
        internalStatus: "pending",
        providerStatus: "not_sent",
        customerExplanation: "Relay is preparing this reply.",
        retryEligibility: "manual",
        recommendedNextAction: "Wait for the current attempt to finish.",
        customerVisible: false,
      });
      const claimed = await claimProviderActionRetry({
        accountId,
        idempotencyKey: actionKey,
        staleBefore: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
      if (!claimed) {
        const existing = typeof getProviderActionByKey === "function"
          ? await getProviderActionByKey(accountId, actionKey)
          : null;
        if (existing?.providerIdentifier && ["accepted", "succeeded", "reconciled"].includes(existing.internalStatus)) {
          const now = existing.lastAttemptAt;
          return Response.json({
            ok: true,
            duplicate: true,
            message: {
              id: existing.providerIdentifier,
              lead_id: lead.id,
              twilio_message_sid: existing.providerIdentifier,
              from_phone: account.twilioPhoneNumber,
              to_phone: lead.phone,
              body,
              status: existing.providerStatus ?? "accepted",
              error: null,
              created_at: now,
              updated_at: now,
            },
          });
        }
        return Response.json(
          { error: "This reply is already being processed. Relay did not send a duplicate." },
          { status: 409 },
        );
      }
    } catch (error) {
      console.error("Reply failed: could not reserve idempotent provider action", {
        accountId,
        leadId: id,
        error: error instanceof Error ? error.message : error,
      });
      return Response.json(
        { error: "Relay could not safely reserve this reply, so it was not sent. Try again." },
        { status: 503 },
      );
    }
  }

  try {
    const statusCallback = new URL("/api/twilio/sms-status", env.appBaseUrl);
    statusCallback.searchParams.set("messageType", "manual_reply");
    statusCallback.searchParams.set("accountId", accountId);
    statusCallback.searchParams.set("leadId", lead.id);
    statusCallback.searchParams.set("actionKey", actionKey);

    const message = await twilioClient.messages.create({
      to: lead.phone,
      from: account.twilioPhoneNumber,
      body,
      statusCallback: statusCallback.toString(),
    });
    messageSid = message.sid;
    initialStatus = message.status || initialStatus;
    if (typeof recordProviderAction === "function") {
      try {
        await recordProviderAction({
          accountId,
          action: "manual_reply_sms",
          provider: "twilio",
          idempotencyKey: actionKey,
          providerIdentifier: messageSid,
          resourceType: "lead",
          resourceId: lead.id,
          internalStatus: "accepted",
          providerStatus: initialStatus,
          customerExplanation: "Twilio accepted the reply. Delivery confirmation is pending.",
          retryEligibility: "never",
          recommendedNextAction: "Wait for the signed delivery callback; do not resend automatically.",
          customerVisible: false,
        });
      } catch (recordError) {
        // Twilio accepted the send. Never report it as failed or invite a duplicate.
        // The signed callback carries account/lead/action evidence and reconciles it.
        console.error("Twilio accepted reply, but provider action evidence update failed", {
          accountId,
          leadId: id,
          twilioMessageSid: messageSid,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown SMS send error";
    if (typeof recordProviderAction === "function") {
      try {
        await recordProviderAction({
          accountId,
          action: "manual_reply_sms",
          provider: "twilio",
          idempotencyKey: actionKey,
          resourceType: "lead",
          resourceId: lead.id,
          internalStatus: "failed",
          providerStatus: "send_failed",
          diagnosticDetail: detail,
          customerVisible: true,
        });
      } catch (recordError) {
        console.error("Reply provider failure could not be recorded", {
          accountId,
          leadId: id,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
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

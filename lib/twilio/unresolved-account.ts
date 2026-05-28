import { notifyAdminOperationalIssue } from "@/lib/email";
import { logWebhookEvent, type AccountResolution } from "@/lib/supabase";
import type { WebhookEventSource } from "@/lib/supabase/types";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

function lastFour(value: string | null | undefined) {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export async function handleUnresolvedTwilioAccount(input: {
  resolution: Extract<AccountResolution, { status: "unresolved" }>;
  source: WebhookEventSource;
  label: string;
  payload: Record<string, string>;
  correlationId: string;
  responseBody?: string;
}) {
  const responseBody = input.responseBody ?? emptyTwiml();
  const detail = [
    `Reason: ${input.resolution.reason}`,
    input.resolution.lookupValue ? `Lookup ending in ${lastFour(input.resolution.lookupValue) ?? "unknown"}` : null,
    input.payload.CallSid ? `CallSid: ${input.payload.CallSid}` : null,
    input.payload.MessageSid ? `MessageSid: ${input.payload.MessageSid}` : null,
    input.payload.To ? `To ending in ${lastFour(input.payload.To) ?? "unknown"}` : null,
    input.payload.From ? `From ending in ${lastFour(input.payload.From) ?? "unknown"}` : null,
  ].filter((line): line is string => Boolean(line));

  console.error("Twilio webhook could not resolve account", {
    source: input.source,
    label: input.label,
    correlationId: input.correlationId,
    reason: input.resolution.reason,
    lookupLast4: lastFour(input.resolution.lookupValue),
    toLast4: lastFour(input.payload.To),
    fromLast4: lastFour(input.payload.From),
  });

  await logWebhookEvent({
    accountId: null,
    source: input.source,
    correlationId: input.correlationId,
    payload: input.payload,
    responseStatus: 200,
    responseBody,
    error: `Unresolved account for ${input.label}: ${input.resolution.reason}`,
  });

  await notifyAdminOperationalIssue({
    account: null,
    issue: `Unresolved Twilio ${input.label} webhook`,
    detail: detail.join("\n"),
    correlationId: input.correlationId,
  });

  return twimlResponse(responseBody);
}

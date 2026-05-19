import { cookies } from "next/headers";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";
import {
  deleteLead,
  getDefaultAccountConfig,
  type LeadStatus,
  type ReplyPriorityOverride,
  updateLead,
} from "@/lib/supabase";

const MAX_NOTES_LENGTH = 2000;
const MAX_NAME_LENGTH = 100;
const MAX_VOICEMAIL_SUMMARY_LENGTH = 500;
const MAX_JOB_VALUE_CENTS = 100_000_000;
const VALID_STATUSES = new Set<LeadStatus>(["new", "contacted", "booked", "dead"]);
const VALID_REPLY_PRIORITY_OVERRIDES = new Set<Exclude<ReplyPriorityOverride, null>>(["fast", "today", "normal"]);

type LeadPatchBody = {
  name?: string | null;
  status?: LeadStatus;
  notes?: string | null;
  booked?: boolean;
  jobValueCents?: number | null;
  replyPriorityOverride?: ReplyPriorityOverride;
  voicemailSummary?: string | null;
  deleted?: boolean;
};

type LeadUpdate = {
  name?: string | null;
  status?: LeadStatus;
  notes?: string | null;
  bookedAt?: string | null;
  jobValueCents?: number | null;
  replyPriorityOverride?: ReplyPriorityOverride;
  voicemailSummary?: string | null;
  deletedAt?: string | null;
};

async function isAuthorized() {
  const cookieStore = await cookies();
  return isValidLeadsSessionCookie(cookieStore.get(LEADS_COOKIE_NAME)?.value);
}

async function readPatchBody(request: Request): Promise<LeadPatchBody | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body as LeadPatchBody : null;
  } catch {
    return null;
  }
}

function validateLeadUpdate(body: LeadPatchBody | null): LeadUpdate | { error: string } {
  if (!body) {
    return { error: "Invalid request body" };
  }

  if (body.name !== null && typeof body.name !== "undefined" && typeof body.name !== "string") {
    return { error: "Invalid name" };
  }

  const name = typeof body.name === "string" ? body.name.trim() || null : body.name;

  if (typeof name === "string" && name.length > MAX_NAME_LENGTH) {
    return { error: "Name is too long" };
  }

  if (body.status && !VALID_STATUSES.has(body.status)) {
    return { error: "Invalid status" };
  }

  if (typeof body.notes === "string" && body.notes.length > MAX_NOTES_LENGTH) {
    return { error: "Notes are too long" };
  }

  if (
    body.voicemailSummary !== null &&
    typeof body.voicemailSummary !== "undefined" &&
    typeof body.voicemailSummary !== "string"
  ) {
    return { error: "Invalid voicemail summary" };
  }

  const voicemailSummary =
    typeof body.voicemailSummary === "string" ? body.voicemailSummary.trim() || null : body.voicemailSummary;

  if (typeof voicemailSummary === "string" && voicemailSummary.length > MAX_VOICEMAIL_SUMMARY_LENGTH) {
    return { error: "Voicemail summary is too long" };
  }

  if (typeof body.booked !== "undefined" && typeof body.booked !== "boolean") {
    return { error: "Invalid booked state" };
  }

  if (
    body.jobValueCents !== null &&
    typeof body.jobValueCents !== "undefined" &&
    (!Number.isInteger(body.jobValueCents) ||
      body.jobValueCents < 0 ||
      body.jobValueCents > MAX_JOB_VALUE_CENTS)
  ) {
    return { error: "Invalid booked value" };
  }

  if (
    body.replyPriorityOverride !== null &&
    typeof body.replyPriorityOverride !== "undefined" &&
    !VALID_REPLY_PRIORITY_OVERRIDES.has(body.replyPriorityOverride)
  ) {
    return { error: "Invalid reply priority" };
  }

  if (
    typeof body.name === "undefined" &&
    !body.status &&
    typeof body.notes === "undefined" &&
    typeof body.booked === "undefined" &&
    typeof body.jobValueCents === "undefined" &&
    typeof body.replyPriorityOverride === "undefined" &&
    typeof body.voicemailSummary === "undefined" &&
    typeof body.deleted === "undefined"
  ) {
    return { error: "Nothing to update" };
  }

  if (typeof body.deleted !== "undefined" && typeof body.deleted !== "boolean") {
    return { error: "Invalid deleted state" };
  }

  return {
    name,
    status: body.status,
    notes: typeof body.notes === "undefined" ? undefined : body.notes,
    bookedAt: typeof body.booked === "undefined" ? undefined : body.booked ? new Date().toISOString() : null,
    jobValueCents: typeof body.jobValueCents === "undefined" ? undefined : body.jobValueCents,
    replyPriorityOverride:
      typeof body.replyPriorityOverride === "undefined" ? undefined : body.replyPriorityOverride,
    voicemailSummary,
    deletedAt: typeof body.deleted === "undefined" ? undefined : body.deleted ? new Date().toISOString() : null,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthorized())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await readPatchBody(request);
  const update = validateLeadUpdate(body);

  if ("error" in update) {
    return Response.json({ error: update.error }, { status: 400 });
  }

  try {
    const account = await getDefaultAccountConfig();
    await updateLead({ accountId: account.accountId, id, ...update });
  } catch (error) {
    console.error("Failed to update lead", { leadId: id, error });
    return Response.json({ error: "Unable to update lead" }, { status: 500 });
  }

  return Response.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthorized())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const account = await getDefaultAccountConfig();
    await deleteLead(id, account.accountId);
  } catch (error) {
    console.error("Failed to delete lead", { leadId: id, error });
    return Response.json({ error: "Unable to delete lead" }, { status: 500 });
  }

  return Response.json({ ok: true });
}

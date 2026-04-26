import { cookies } from "next/headers";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";
import { type LeadStatus, updateLead } from "@/lib/supabase";

const MAX_NOTES_LENGTH = 2000;
const VALID_STATUSES = new Set<LeadStatus>(["new", "contacted", "booked", "dead"]);

type LeadPatchBody = {
  status?: LeadStatus;
  notes?: string | null;
};

type LeadUpdate = {
  status?: LeadStatus;
  notes?: string | null;
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

  if (body.status && !VALID_STATUSES.has(body.status)) {
    return { error: "Invalid status" };
  }

  if (typeof body.notes === "string" && body.notes.length > MAX_NOTES_LENGTH) {
    return { error: "Notes are too long" };
  }

  if (!body.status && typeof body.notes === "undefined") {
    return { error: "Nothing to update" };
  }

  return {
    status: body.status,
    notes: typeof body.notes === "undefined" ? undefined : body.notes,
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
    await updateLead({ id, ...update });
  } catch (error) {
    console.error("Failed to update lead", { leadId: id, error });
    return Response.json({ error: "Unable to update lead" }, { status: 500 });
  }

  return Response.json({ ok: true });
}

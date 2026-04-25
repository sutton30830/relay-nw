import { cookies } from "next/headers";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";
import { type LeadStatus, updateLead } from "@/lib/supabase";

const VALID_STATUSES = new Set<LeadStatus>(["new", "contacted", "booked", "dead"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  const isAllowed = isValidLeadsSessionCookie(cookieStore.get(LEADS_COOKIE_NAME)?.value);

  if (!isAllowed) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json()) as { status?: LeadStatus; notes?: string | null };

  if (body.status && !VALID_STATUSES.has(body.status)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }

  if (typeof body.notes === "string" && body.notes.length > 2000) {
    return Response.json({ error: "Notes are too long" }, { status: 400 });
  }

  if (!body.status && typeof body.notes === "undefined") {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  await updateLead({
    id,
    status: body.status,
    notes: typeof body.notes === "undefined" ? undefined : body.notes,
  });

  return Response.json({ ok: true });
}

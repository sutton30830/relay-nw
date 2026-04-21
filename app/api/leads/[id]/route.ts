import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { type LeadStatus, updateLeadStatus } from "@/lib/supabase";

const VALID_STATUSES = new Set<LeadStatus>(["new", "contacted", "booked", "dead"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  const isAllowed = cookieStore.get("relay_leads_password")?.value === env.leadsPassword;

  if (!isAllowed) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json()) as { status?: LeadStatus };

  if (!body.status || !VALID_STATUSES.has(body.status)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }

  await updateLeadStatus({ id, status: body.status });

  return Response.json({ ok: true });
}

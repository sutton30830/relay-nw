import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import { exportAccountData, recordPlatformAuditEvent } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.accountExport);
  const accountId = new URL(request.url).searchParams.get("account_id")?.trim() ?? "";
  if (!accountId) return Response.json({ error: "Account id is required." }, { status: 400 });

  const exported = await exportAccountData(accountId);
  if (!exported) return Response.json({ error: "Account not found." }, { status: 404 });

  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    targetAccountId: accountId,
    action: "account.data.exported",
    summary: "Exported the tenant-scoped account data package.",
  }, { required: true });

  return new Response(JSON.stringify(exported, null, 2), {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": `attachment; filename="relay-account-${accountId}.json"`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

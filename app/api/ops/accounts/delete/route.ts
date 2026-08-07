import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS, hasExplicitOpsConfirmation } from "@/lib/ops-actions";
import { deleteAccountWithProviders } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.accountDelete);
  const form = await request.formData();
  const accountId = String(form.get("account_id") ?? "").trim();
  const mode = String(form.get("mode") ?? "dry_run");
  const dryRun = mode !== "execute";
  if (!accountId) return Response.json({ error: "Account id is required." }, { status: 400 });
  if (!dryRun && !hasExplicitOpsConfirmation(form.get("confirmation"))) {
    return Response.json({ error: "Exact deletion confirmation is required." }, { status: 400 });
  }

  try {
    const result = await deleteAccountWithProviders({
      accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      dryRun,
    });
    return Response.json(result, {
      status: result.status === "partial_failure" ? 207 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Account deletion failed.",
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
}

import { requirePlatformOperatorWriteJson } from "@/lib/auth";
import { notifyOwnerTestEmail } from "@/lib/email";
import { getAccountConfigByAccountId, getOpsAccountBySlug } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requirePlatformOperatorWriteJson();
  if (auth.response) return auth.response;

  const formData = await request.formData();
  const accountSlug = String(formData.get("account_slug") ?? "").trim();
  const target = await getOpsAccountBySlug(accountSlug);
  if (!target) {
    return Response.json({ ok: false, error: "Account not found" }, { status: 404 });
  }

  const account = await getAccountConfigByAccountId(target.accountId);
  if (!account) {
    return Response.json({ ok: false, error: "Account configuration not found" }, { status: 409 });
  }

  const result = await notifyOwnerTestEmail({
    account,
    requestedBy: auth.session.email,
  });

  const status = result.sent ? 200 : result.skipped ? 409 : 502;

  return Response.json(
    {
      ok: result.sent,
      skipped: result.skipped,
      id: result.id ?? null,
      error: result.error ? "Email provider rejected the message. Check Vercel logs for detail." : null,
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

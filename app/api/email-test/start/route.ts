import { requireAccountUserJson } from "@/lib/auth";
import { notifyOwnerTestEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireAccountUserJson();
  if (auth.response) return auth.response;

  const result = await notifyOwnerTestEmail({
    account: auth.session.account,
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

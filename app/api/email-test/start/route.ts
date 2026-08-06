import { requirePlatformOperatorWriteJson } from "@/lib/auth";
import { notifyOwnerTestEmail } from "@/lib/email";
import {
  getAccountConfigByAccountId,
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordOwnerNotificationSent,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requirePlatformOperatorWriteJson();
  if (auth.response) return auth.response;

  const formData = await request.formData();
  const accountSlug = String(formData.get("account_slug") ?? "").trim();
  const returnTo = String(formData.get("return_to") ?? "").trim();
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

  if (result.sent) {
    await recordOwnerNotificationSent({
      accountId: target.accountId,
      providerId: result.id ?? "provider-accepted",
    });
    const summary = `Sent owner notification test for ${account.businessName}`;
    await Promise.all([
      recordAccountAuditEvents({
        accountId: target.accountId,
        actorUserId: auth.session.userId,
        actorEmail: auth.session.email,
        events: [{ action: "onboarding.owner_notification_test_sent", summary }],
      }),
      recordPlatformAuditEvent({
        actorUserId: auth.session.userId,
        actorEmail: auth.session.email,
        targetAccountId: target.accountId,
        action: "onboarding.owner_notification_test_sent",
        summary,
      }),
    ]);
  }

  if (returnTo === "ops_onboarding") {
    const resultCode = result.sent ? "sent" : result.skipped ? "skipped" : "failed";
    return Response.redirect(
      new URL(`/ops/accounts/${encodeURIComponent(accountSlug)}?onboarding_test=${resultCode}#onboarding`, request.url),
      303,
    );
  }

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

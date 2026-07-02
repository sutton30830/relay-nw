import { env } from "@/lib/env";
import { notifyOwnerWeeklyDigest } from "@/lib/email";
import {
  getAccountConfigByAccountId,
  getAccountRecoveryStats,
  listActiveAccountIds,
} from "@/lib/supabase";

// Vercel cron hits this weekly (see vercel.json). Vercel automatically sends
// `Authorization: Bearer ${CRON_SECRET}` when the CRON_SECRET env var is set.
export async function GET(request: Request) {
  if (!env.cronSecret) {
    console.error("Weekly digest skipped: CRON_SECRET is not configured.");
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }

  if (request.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const accountIds = await listActiveAccountIds();
  const results: Array<{ accountId: string; sent: boolean; error?: string }> = [];

  for (const accountId of accountIds) {
    try {
      const account = await getAccountConfigByAccountId(accountId);

      if (!account) {
        results.push({ accountId, sent: false, error: "no account config" });
        continue;
      }

      const stats = await getAccountRecoveryStats(accountId, { since });

      // Nothing happened, nothing to brag about — skip rather than send an empty email.
      if (stats.missedCalls === 0 && stats.replies === 0 && stats.booked === 0) {
        results.push({ accountId, sent: false, error: "no activity" });
        continue;
      }

      const outcome = await notifyOwnerWeeklyDigest({
        account,
        stats,
        periodLabel: "this week",
      });

      results.push({ accountId, sent: Boolean(outcome.sent) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown digest error";
      console.error("Weekly digest failed for account", { accountId, error: message });
      results.push({ accountId, sent: false, error: message });
    }
  }

  console.info("Weekly digest run complete", {
    accounts: accountIds.length,
    sent: results.filter((result) => result.sent).length,
  });

  return Response.json({ ok: true, results });
}

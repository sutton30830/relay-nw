import { env } from "@/lib/env";
import { recordCronCheckIn } from "@/lib/cron-checkins";
import { notifyOwnerWeeklyDigest } from "@/lib/email";
import {
  getAccountConfigByAccountId,
  getAccountRecoveryStats,
  listActiveAccountIds,
} from "@/lib/supabase";

export const maxDuration = 300;

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
  const runKey = new Date().toISOString().slice(0, 10);

  for (const accountId of accountIds) {
    try {
      const account = await getAccountConfigByAccountId(accountId);

      if (!account) {
        results.push({ accountId, sent: false, error: "no account config" });
        await recordCronCheckIn({ accountId, job: "scheduled_weekly_digest", runKey, ok: false, detail: "Account configuration was unavailable." });
        continue;
      }

      const stats = await getAccountRecoveryStats(accountId, { since });

      // Nothing happened, nothing to brag about — skip rather than send an empty email.
      if (stats.missedCalls === 0 && stats.replies === 0 && stats.booked === 0) {
        results.push({ accountId, sent: false, error: "no activity" });
        await recordCronCheckIn({ accountId, job: "scheduled_weekly_digest", runKey, ok: true, detail: "Checked in; no activity required a digest." });
        continue;
      }

      const outcome = await notifyOwnerWeeklyDigest({
        account,
        stats,
        periodLabel: "this week",
      });

      results.push({ accountId, sent: Boolean(outcome.sent) });
      await recordCronCheckIn({
        accountId,
        job: "scheduled_weekly_digest",
        runKey,
        ok: Boolean(outcome.sent),
        detail: outcome.sent ? "Weekly digest accepted by the email provider." : "Weekly digest was not accepted by the email provider.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown digest error";
      console.error("Weekly digest failed for account", { accountId, error: message });
      results.push({ accountId, sent: false, error: message });
      await recordCronCheckIn({ accountId, job: "scheduled_weekly_digest", runKey, ok: false, detail: message });
    }
  }

  console.info("Weekly digest run complete", {
    accounts: accountIds.length,
    sent: results.filter((result) => result.sent).length,
  });

  return Response.json({ ok: true, results });
}

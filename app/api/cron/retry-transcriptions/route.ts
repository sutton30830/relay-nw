import { env } from "@/lib/env";
import { recordCronCheckIn } from "@/lib/cron-checkins";
import { withCronMonitor } from "@/lib/cron-monitor";
import {
  listActiveAccountIds,
  listLeadsNeedingSummaryRetry,
  listLeadsNeedingTranscriptionRetry,
} from "@/lib/supabase";
import { transcribeLeadVoicemail } from "@/lib/voicemail-ai";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!env.cronSecret) {
    console.error("Voicemail transcription retry skipped: CRON_SECRET is not configured.");
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }

  if (request.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronMonitor({
    slug: "relay-transcription-retry",
    schedule: { type: "crontab", value: "30 15 * * *" },
    checkInMarginMinutes: 10,
    maxRuntimeMinutes: 5,
    run: runAuthorizedTranscriptionRetry,
  });
}

async function runAuthorizedTranscriptionRetry() {
  const [transcriptionLeads, summaryLeads, activeAccountIds] = await Promise.all([
    listLeadsNeedingTranscriptionRetry(),
    listLeadsNeedingSummaryRetry(),
    listActiveAccountIds(),
  ]);
  const leads = [...new Map(
    [...transcriptionLeads, ...summaryLeads].map((lead) => [`${lead.account_id}:${lead.id}`, lead]),
  ).values()];
  let succeeded = 0;
  let skipped = 0;
  const successes: Array<{ leadId: string; accountId: string }> = [];
  const skips: Array<{ leadId: string; accountId: string }> = [];
  const failures: Array<{ leadId: string; accountId: string; error: string }> = [];

  for (const lead of leads) {
    try {
      await transcribeLeadVoicemail(lead.id, lead.account_id);
      succeeded += 1;
      successes.push({ leadId: lead.id, accountId: lead.account_id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown transcription retry error";

      if (message === "Voicemail summary is already generating.") {
        skipped += 1;
        skips.push({ leadId: lead.id, accountId: lead.account_id });
        continue;
      }

      console.error("Voicemail transcription retry failed", {
        leadId: lead.id,
        accountId: lead.account_id,
        error: message,
      });
      failures.push({ leadId: lead.id, accountId: lead.account_id, error: message });
    }
  }

  console.info("Voicemail transcription retry run complete", {
    attempted: leads.length,
    succeeded,
    skipped,
    failed: failures.length,
  });

  const runKey = new Date().toISOString().slice(0, 10);
  const checkIns = await Promise.all(activeAccountIds.map((accountId) => {
    const accountFailures = failures.filter((failure) => failure.accountId === accountId);
    const accountEligible = leads.filter((lead) => lead.account_id === accountId).length;
    const accountSucceeded = successes.filter((success) => success.accountId === accountId).length;
    const accountSkipped = skips.filter((skip) => skip.accountId === accountId).length;
    return recordCronCheckIn({
      accountId,
      job: "scheduled_transcription_retry",
      runKey,
      ok: accountFailures.length === 0,
      detail: `Eligible ${accountEligible}; recovered ${accountSucceeded}; skipped ${accountSkipped}; failed ${accountFailures.length}.`,
    });
  }));

  const checkInFailures = checkIns.filter((ok) => !ok).length;
  const ok = failures.length === 0 && checkInFailures === 0;

  return Response.json({
    ok,
    attempted: leads.length,
    succeeded,
    skipped,
    failed: failures.length,
    checkInFailures,
    failures,
  }, { status: ok ? 200 : 502 });
}

import { env } from "@/lib/env";
import { recordCronCheckIn } from "@/lib/cron-checkins";
import { listActiveAccountIds, listLeadsNeedingTranscriptionRetry } from "@/lib/supabase";
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

  const [leads, activeAccountIds] = await Promise.all([
    listLeadsNeedingTranscriptionRetry(),
    listActiveAccountIds(),
  ]);
  let succeeded = 0;
  let skipped = 0;
  const failures: Array<{ leadId: string; accountId: string; error: string }> = [];

  for (const lead of leads) {
    try {
      await transcribeLeadVoicemail(lead.id, lead.account_id);
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown transcription retry error";

      if (message === "Voicemail summary is already generating.") {
        skipped += 1;
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
  await Promise.all(activeAccountIds.map((accountId) => {
    const accountFailures = failures.filter((failure) => failure.accountId === accountId);
    return recordCronCheckIn({
      accountId,
      job: "scheduled_transcription_retry",
      runKey,
      ok: accountFailures.length === 0,
      detail: accountFailures.length === 0
        ? `Checked ${leads.filter((lead) => lead.account_id === accountId).length} eligible voicemail retries.`
        : `${accountFailures.length} voicemail retry attempt${accountFailures.length === 1 ? "" : "s"} failed.`,
    });
  }));

  return Response.json({
    ok: true,
    attempted: leads.length,
    succeeded,
    skipped,
    failed: failures.length,
    failures,
  });
}

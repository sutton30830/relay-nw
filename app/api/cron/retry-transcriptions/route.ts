import { env } from "@/lib/env";
import { listLeadsNeedingTranscriptionRetry } from "@/lib/supabase";
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

  const leads = await listLeadsNeedingTranscriptionRetry();
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

  return Response.json({
    ok: true,
    attempted: leads.length,
    succeeded,
    skipped,
    failed: failures.length,
    failures,
  });
}

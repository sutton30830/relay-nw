import { recordProviderAction } from "@/lib/supabase/provider-actions";

export type MonitoredCronJob =
  | "scheduled_operations_monitoring"
  | "scheduled_transcription_retry"
  | "scheduled_retention"
  | "scheduled_weekly_digest";

export async function recordCronCheckIn(input: {
  accountId: string;
  job: MonitoredCronJob;
  runKey: string;
  ok: boolean;
  detail: string;
}) {
  try {
    await recordProviderAction({
      accountId: input.accountId,
      action: input.job,
      provider: "relay",
      idempotencyKey: `cron:${input.job}:${input.runKey}`,
      resourceType: "account",
      resourceId: input.accountId,
      internalStatus: input.ok ? "succeeded" : "failed",
      providerStatus: input.ok ? "checked_in" : "job_failed",
      // This is content-free operational evidence (counts/outcome only). Keep
      // it on successful runs too so Monitoring can explain what the job did,
      // rather than showing only a timestamp and a green status.
      diagnosticDetail: input.detail,
      customerExplanation: "Relay completed a scheduled service check.",
      retryEligibility: input.ok ? "never" : "automatic",
      recommendedNextAction: input.ok
        ? "No action is needed."
        : "Inspect the scheduled job and retry only its idempotent recovery work.",
      customerVisible: false,
      countAttempt: true,
    });
    return true;
  } catch (error) {
    console.error("Scheduled job check-in could not be recorded", {
      accountId: input.accountId,
      job: input.job,
      error: error instanceof Error ? error.message : error,
    });
    return false;
  }
}

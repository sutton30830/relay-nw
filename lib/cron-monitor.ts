import "server-only";

import * as Sentry from "@sentry/nextjs";

type CronSchedule =
  | { type: "crontab"; value: string }
  | { type: "interval"; value: number; unit: "year" | "month" | "week" | "day" | "hour" | "minute" };

export async function withCronMonitor(input: {
  slug: string;
  schedule: CronSchedule;
  checkInMarginMinutes: number;
  maxRuntimeMinutes: number;
  run: () => Promise<Response>;
}) {
  let checkInId: string | null = null;
  const startedAt = Date.now();

  try {
    checkInId = Sentry.captureCheckIn({
      monitorSlug: input.slug,
      status: "in_progress",
    }, {
      schedule: input.schedule,
      checkinMargin: input.checkInMarginMinutes,
      maxRuntime: input.maxRuntimeMinutes,
      timezone: "UTC",
      failureIssueThreshold: 1,
      recoveryThreshold: 1,
    });
  } catch (error) {
    console.error("Sentry cron check-in could not start", {
      slug: input.slug,
      error: error instanceof Error ? error.message : error,
    });
  }

  try {
    const response = await input.run();
    if (checkInId) {
      try {
        Sentry.captureCheckIn({
          monitorSlug: input.slug,
          status: response.ok ? "ok" : "error",
          checkInId,
          duration: (Date.now() - startedAt) / 1000,
        });
      } catch (error) {
        console.error("Sentry cron check-in could not finish", {
          slug: input.slug,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
    return response;
  } catch (error) {
    if (checkInId) {
      try {
        Sentry.captureCheckIn({
          monitorSlug: input.slug,
          status: "error",
          checkInId,
          duration: (Date.now() - startedAt) / 1000,
        });
      } catch (checkInError) {
        console.error("Sentry cron failure check-in could not finish", {
          slug: input.slug,
          error: checkInError instanceof Error ? checkInError.message : checkInError,
        });
      }
    }
    throw error;
  }
}

import { env } from "@/lib/env";
import {
  notifyAdminOperationalIssue,
  notifyOwnerOnboardingPaused,
  notifyOwnerOnboardingRequirementsReminder,
} from "@/lib/email";
import {
  ONBOARDING_DEADLINE_ACTIONS,
  chooseOnboardingDeadlineAction,
  type OnboardingDeadlineAction,
} from "@/lib/onboarding-deadlines";
import {
  getAccountConfigByAccountId,
  hasAccountAuditAction,
  listAccountsForOnboardingDeadlineMaintenance,
  recordAccountAuditEvents,
  updateAccountBillingRecord,
  type OnboardingDeadlineAccount,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

type DeadlineResult = {
  accountId: string;
  accountSlug: string;
  action: OnboardingDeadlineAction;
  ok: boolean;
  error?: string;
};

function authError(request: Request) {
  if (!env.cronSecret) {
    console.error("Onboarding deadline maintenance skipped: CRON_SECRET is not configured.");
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }

  if (request.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

function auditSummary(action: Exclude<OnboardingDeadlineAction, "none">, account: OnboardingDeadlineAccount) {
  if (action === "remind_day_3") {
    return `Sent day-3 requirements reminder for ${account.accountSlug}.`;
  }
  if (action === "remind_day_7") {
    return `Sent day-7 requirements reminder for ${account.accountSlug}.`;
  }
  if (action === "pause_incomplete") {
    return `Paused incomplete onboarding for ${account.accountSlug}.`;
  }

  return `Closed incomplete onboarding for ${account.accountSlug}.`;
}

async function completedActionsFor(accountId: string) {
  const entries = await Promise.all(
    Object.values(ONBOARDING_DEADLINE_ACTIONS).map(async (action) => [
      action,
      await hasAccountAuditAction(accountId, action),
    ] as const),
  );

  return new Set(entries.filter(([, done]) => done).map(([action]) => action));
}

async function notifyForAction(input: {
  account: OnboardingDeadlineAccount;
  action: Exclude<OnboardingDeadlineAction, "none">;
}) {
  const runtimeAccount = await getAccountConfigByAccountId(input.account.accountId);

  if (input.action === "remind_day_3" || input.action === "remind_day_7") {
    if (runtimeAccount && input.account.requirementsDueAt) {
      await notifyOwnerOnboardingRequirementsReminder({
        account: runtimeAccount,
        requirementsDueAt: input.account.requirementsDueAt,
        reminder: input.action === "remind_day_3" ? "day_3" : "day_7",
      });
    }

    if (input.action === "remind_day_7") {
      await notifyAdminOperationalIssue({
        account: runtimeAccount,
        issue: "Onboarding requirements still waiting on customer",
        detail: `${input.account.accountSlug} is 7 days into customer requirements follow-up.`,
        correlationId: input.account.accountId,
      });
    }

    return;
  }

  if (input.action === "pause_incomplete") {
    await updateAccountBillingRecord(input.account.accountId, {
      onboardingStatus: "paused_incomplete",
    });

    if (runtimeAccount) {
      await notifyOwnerOnboardingPaused({ account: runtimeAccount });
    }

    await notifyAdminOperationalIssue({
      account: runtimeAccount,
      issue: "Onboarding paused incomplete",
      detail: `${input.account.accountSlug} missed the 14-day customer requirements deadline.`,
      correlationId: input.account.accountId,
    });
    return;
  }

  await updateAccountBillingRecord(input.account.accountId, {
    onboardingStatus: "closed_incomplete",
  });

  await notifyAdminOperationalIssue({
    account: runtimeAccount,
    issue: "Onboarding closed incomplete",
    detail: `${input.account.accountSlug} reached the 30-day incomplete onboarding cutoff. Reopening requires operator action and a new requirements deadline.`,
    correlationId: input.account.accountId,
  });
}

async function processAccount(account: OnboardingDeadlineAccount, now: Date): Promise<DeadlineResult> {
  try {
    const action = chooseOnboardingDeadlineAction({
      onboardingStatus: account.onboardingStatus,
      requirementsDueAt: account.requirementsDueAt,
      completedActions: await completedActionsFor(account.accountId),
      now,
    });

    if (action === "none") {
      return { accountId: account.accountId, accountSlug: account.accountSlug, action, ok: true };
    }

    await notifyForAction({ account, action });
    await recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: null,
      actorEmail: "system:onboarding-deadlines",
      events: [
        {
          action: ONBOARDING_DEADLINE_ACTIONS[action],
          summary: auditSummary(action, account),
        },
      ],
    });

    return { accountId: account.accountId, accountSlug: account.accountSlug, action, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown onboarding deadline error";
    console.error("Onboarding deadline maintenance failed for account", {
      accountId: account.accountId,
      accountSlug: account.accountSlug,
      error: message,
    });

    try {
      await notifyAdminOperationalIssue({
        issue: "Onboarding deadline maintenance failed",
        detail: `${account.accountSlug}: ${message}`,
        correlationId: account.accountId,
      });
    } catch (alertError) {
      console.error("Onboarding deadline failure alert failed", {
        accountId: account.accountId,
        error: alertError instanceof Error ? alertError.message : alertError,
      });
    }

    return { accountId: account.accountId, accountSlug: account.accountSlug, action: "none", ok: false, error: message };
  }
}

export async function GET(request: Request) {
  const error = authError(request);
  if (error) return error;

  const now = new Date();
  const accounts = await listAccountsForOnboardingDeadlineMaintenance();
  const results: DeadlineResult[] = [];

  for (const account of accounts) {
    results.push(await processAccount(account, now));
  }

  const changed = results.filter((result) => result.action !== "none").length;
  const failed = results.filter((result) => !result.ok).length;

  console.info("Onboarding deadline maintenance run complete", {
    accounts: accounts.length,
    changed,
    failed,
  });

  return Response.json({
    ok: failed === 0,
    accounts: accounts.length,
    changed,
    failed,
    results,
  });
}

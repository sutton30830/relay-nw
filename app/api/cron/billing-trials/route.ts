import { env } from "@/lib/env";
import {
  notifyAdminOperationalIssue,
  notifyOwnerBillingTrialExpired,
} from "@/lib/email";
import {
  BILLING_TRIAL_EXPIRY_ACTION,
  chooseBillingTrialExpiryAction,
} from "@/lib/billing";
import {
  getAccountConfigByAccountId,
  hasAccountAuditAction,
  listAccountsForBillingTrialExpiry,
  recordAccountAuditEvents,
  updateAccountBillingRecord,
  type BillingTrialExpiryAccount,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

type BillingTrialResult = {
  accountId: string;
  accountSlug: string;
  action: "expire_app_trial" | "none";
  ok: boolean;
  error?: string;
};

function authError(request: Request) {
  if (!env.cronSecret) {
    console.error("Billing trial maintenance skipped: CRON_SECRET is not configured.");
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }

  if (request.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

async function completedActionsFor(accountId: string) {
  return new Set(
    (await hasAccountAuditAction(accountId, BILLING_TRIAL_EXPIRY_ACTION))
      ? [BILLING_TRIAL_EXPIRY_ACTION]
      : [],
  );
}

function auditSummary(account: BillingTrialExpiryAccount) {
  return `Expired app-level trial for ${account.accountSlug}; owner needs to start billing. Call capture remains on.`;
}

async function processAccount(account: BillingTrialExpiryAccount, now: Date): Promise<BillingTrialResult> {
  try {
    const action = chooseBillingTrialExpiryAction({
      billingStatus: account.billingStatus,
      stripeSubscriptionId: account.stripeSubscriptionId,
      trialEndsAt: account.trialEndsAt,
      completedActions: await completedActionsFor(account.accountId),
      now,
    });

    if (action === "none") {
      return { accountId: account.accountId, accountSlug: account.accountSlug, action, ok: true };
    }

    const runtimeAccount = await getAccountConfigByAccountId(account.accountId);
    const nowIso = now.toISOString();

    await updateAccountBillingRecord(account.accountId, {
      billingStatus: "past_due",
      billingAttentionSince: nowIso,
      cancelAtPeriodEnd: false,
    });

    if (runtimeAccount) {
      await notifyOwnerBillingTrialExpired({
        account: runtimeAccount,
        trialEndsAt: account.trialEndsAt,
      });
    }

    await notifyAdminOperationalIssue({
      account: runtimeAccount,
      issue: "Billing trial expired",
      detail: `${account.accountSlug} reached the end of its app-level trial. Owner needs to start billing; call capture remains on.`,
      correlationId: account.accountId,
    });

    await recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: null,
      actorEmail: "system:billing-trials",
      events: [
        {
          action: BILLING_TRIAL_EXPIRY_ACTION,
          summary: auditSummary(account),
        },
      ],
    });

    return { accountId: account.accountId, accountSlug: account.accountSlug, action, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown billing trial maintenance error";
    console.error("Billing trial maintenance failed for account", {
      accountId: account.accountId,
      accountSlug: account.accountSlug,
      error: message,
    });

    try {
      await notifyAdminOperationalIssue({
        issue: "Billing trial maintenance failed",
        detail: `${account.accountSlug}: ${message}`,
        correlationId: account.accountId,
      });
    } catch (alertError) {
      console.error("Billing trial maintenance failure alert failed", {
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
  const accounts = await listAccountsForBillingTrialExpiry(now.toISOString());
  const results: BillingTrialResult[] = [];

  for (const account of accounts) {
    results.push(await processAccount(account, now));
  }

  const changed = results.filter((result) => result.action !== "none").length;
  const failed = results.filter((result) => !result.ok).length;

  console.info("Billing trial maintenance run complete", {
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

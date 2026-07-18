import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import {
  canMoveAccountToCustomerDelay,
  getOpsOnboardingAccountBySlug,
  markAccountRequirementsRequested,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

function readString(formData: FormData, key: string, maxLength = 120) {
  return String(formData.get(key) ?? "").trim().slice(0, maxLength);
}

function redirectWith(status: string, accountSlug?: string) {
  const params = new URLSearchParams({ onboarding: status });
  if (accountSlug) params.set("account", accountSlug);
  redirect(`/ops/billing?${params.toString()}`);
}

export async function POST(request: Request) {
  const session = await requirePlatformOperator();
  const formData = await request.formData();
  const accountSlug = readString(formData, "account_slug", 80);

  if (!accountSlug) {
    return redirectWith("missing_account");
  }

  const account = await getOpsOnboardingAccountBySlug(accountSlug);
  if (!account) {
    return redirectWith("account_not_found", accountSlug);
  }

  if (!canMoveAccountToCustomerDelay(account.onboardingStatus, account)) {
    return redirectWith("not_customer_delay", account.accountSlug);
  }

  try {
    await markAccountRequirementsRequested({
      accountId: account.accountId,
      previousOnboardingStatus: account.onboardingStatus,
      actorUserId: session.userId,
      actorEmail: session.email,
    });
    await recordPlatformAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      targetAccountId: account.accountId,
      action: "onboarding.operator.customer_delay",
      summary: account.onboardingStatus === "paused_incomplete" || account.onboardingStatus === "closed_incomplete"
        ? "Reopened customer requirements deadline"
        : "Started customer requirements deadline",
    });
  } catch (error) {
    console.error("Operator onboarding deadline update failed", {
      accountSlug: account.accountSlug,
      error: error instanceof Error ? error.message : error,
    });
    return redirectWith("save_failed", account.accountSlug);
  }

  return redirectWith(
    account.onboardingStatus === "paused_incomplete" || account.onboardingStatus === "closed_incomplete"
      ? "reopened"
      : "requested",
    account.accountSlug,
  );
}

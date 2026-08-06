import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { loadAccountOnboardingReadiness } from "@/lib/onboarding-readiness";
import {
  recordAccountAuditEvents,
  recordCustomerOnboardingConfirmation,
} from "@/lib/supabase";

function go(value: string): never {
  redirect(`/setup?onboarding=${encodeURIComponent(value)}#approval`);
}

export async function POST(request: Request) {
  const session = await requireAccountUser();
  if (session.role !== "owner") go("owner_required");

  const form = await request.formData();
  const action = String(form.get("action") ?? "").trim();
  const confirmed = form.get("confirmation") === "confirmed";
  if (!confirmed) go("confirmation_required");
  if (action !== "confirm_owner_notification" && action !== "approve_go_live") {
    go("invalid_action");
  }

  const onboarding = await loadAccountOnboardingReadiness(session.accountId);

  if (action === "confirm_owner_notification") {
    if (!onboarding.evidence.ownerNotificationSentAt) go("notification_not_sent");
  } else {
    const blockingChecks = onboarding.readiness.checks.filter(
      (check) => check.key !== "customer_approval" && check.status !== "complete",
    );
    if (onboarding.readiness.state === "blocked" || blockingChecks.length > 0) {
      go("not_ready");
    }
  }

  await recordCustomerOnboardingConfirmation({
    accountId: session.accountId,
    action,
    userId: session.userId,
    email: session.email,
  });

  await recordAccountAuditEvents({
    accountId: session.accountId,
    actorUserId: session.userId,
    actorEmail: session.email,
    events: [{
      action: action === "approve_go_live"
        ? "onboarding.customer_go_live_approved"
        : "onboarding.owner_notification_confirmed",
      summary: action === "approve_go_live"
        ? "Authenticated owner explicitly approved production go-live."
        : "Authenticated owner confirmed receiving the notification test.",
    }],
  });

  go(action === "approve_go_live" ? "approved" : "notification_confirmed");
}

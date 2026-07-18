import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Billing controls live on each customer's own page now. This route survives
// only so old bookmarks, emails, and API redirects keep working.
export default async function OpsBillingRedirect({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; billing_action?: string; onboarding?: string }>;
}) {
  await requirePlatformOperator();
  const { account, billing_action: billingAction, onboarding } = await searchParams;

  if (account) {
    const params = new URLSearchParams();
    if (billingAction) params.set("billing_action", billingAction);
    if (onboarding) params.set("onboarding", onboarding);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    redirect(`/ops/accounts/${encodeURIComponent(account)}${suffix}`);
  }

  redirect("/ops");
}

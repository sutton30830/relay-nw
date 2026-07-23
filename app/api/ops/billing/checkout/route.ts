import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { getBillingCheckoutEligibility } from "@/lib/billing";
import { createStripeCheckoutSession } from "@/lib/stripe-billing";
import {
  getAccountBillingRecord,
  getAccountConfigByAccountId,
  getAccountTechnicalSetupStatus,
  getOpsBillingAccountBySlug,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

function redirectWith(accountSlug: string, status: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(accountSlug)}?billing_action=${status}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  const formData = await request.formData();
  const accountSlug = String(formData.get("account_slug") ?? "").trim();
  if (!accountSlug) redirect("/ops");

  const account = await getOpsBillingAccountBySlug(accountSlug);
  if (!account) redirectWith(accountSlug, "account_not_found");

  const runtime = await getAccountConfigByAccountId(account.accountId);
  if (!runtime) redirectWith(account.accountSlug, "account_not_found");

  const [technicalStatus, billing] = await Promise.all([
    getAccountTechnicalSetupStatus(account.accountId),
    getAccountBillingRecord(account.accountId),
  ]);
  const eligibility = getBillingCheckoutEligibility({
    billing,
    technicalStatus,
  });
  if (!eligibility.ok) redirectWith(account.accountSlug, eligibility.reason);

  let checkoutUrl: string;
  try {
    const checkout = await createStripeCheckoutSession({
      accountId: account.accountId,
      accountSlug: account.accountSlug,
      ownerEmail: runtime.ownerEmail ?? operator.email,
      stripeCustomerId: billing.stripeCustomerId,
      trialPeriodDays: 0,
      idempotencyKey: [
        "relay-ops-checkout",
        account.accountId,
        billing.billingStatus,
        billing.stripeCustomerId ?? "new-customer",
        billing.stripeSubscriptionId ?? "no-subscription",
      ].join(":"),
    });
    checkoutUrl = checkout.url;
    await recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: "billing.operator.checkout_started",
      summary: "Started activation-gated monthly subscription Checkout for the selected account.",
    });
  } catch (error) {
    console.error("Operator Stripe checkout creation failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    redirectWith(account.accountSlug, "checkout_failed");
  }

  redirect(checkoutUrl);
}

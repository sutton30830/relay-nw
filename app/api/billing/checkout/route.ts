import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { createStripeCheckoutSession } from "@/lib/stripe-billing";
import { getAccountBillingRecord } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await requireAccountUser();

  if (session.role !== "owner") {
    redirect("/setup?billing=forbidden");
  }

  const billing = await getAccountBillingRecord(session.accountId);
  let checkoutUrl: string;

  try {
    const checkout = await createStripeCheckoutSession({
      accountId: session.accountId,
      accountSlug: session.account.accountSlug,
      ownerEmail: session.account.ownerEmail ?? session.email,
      stripeCustomerId: billing.stripeCustomerId,
    });
    checkoutUrl = checkout.url;
  } catch (error) {
    console.error("Stripe checkout creation failed", {
      accountId: session.accountId,
      error: error instanceof Error ? error.message : error,
    });

    redirect("/setup?billing=checkout_failed");
  }

  redirect(checkoutUrl);
}

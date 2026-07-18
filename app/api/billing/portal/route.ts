import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { createStripePortalSession } from "@/lib/stripe-billing";
import { getAccountBillingRecord, recordPlatformAuditEvent, updateAccountBillingRecord } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function billingRedirect(reason: string): never {
  redirect(`/settings?billing=${reason}#billing`);
}

export async function POST() {
  const session = await requireAccountUser();

  if (session.role !== "owner") {
    billingRedirect("forbidden");
  }

  const billing = await getAccountBillingRecord(session.accountId);

  if (!billing.stripeCustomerId) {
    billingRedirect("no_customer");
  }

  let portalUrl: string;

  try {
    const portal = await createStripePortalSession({
      stripeCustomerId: billing.stripeCustomerId,
      returnUrl: `${env.appBaseUrl}/settings#billing`,
    });
    portalUrl = portal.url;
  } catch (error) {
    console.error("Stripe portal creation failed", {
      accountId: session.accountId,
      error: error instanceof Error ? error.message : error,
    });

    const message = error instanceof Error ? error.message : String(error);
    if (/no such customer|resource_missing/i.test(message)) {
      await updateAccountBillingRecord(session.accountId, { stripeCustomerId: null });
      await recordPlatformAuditEvent({
        actorUserId: session.userId,
        actorEmail: session.email,
        action: "billing.customer_link_reset",
        summary: "Cleared an invalid billing customer link so billing can be reconnected",
        targetAccountId: session.accountId,
      });
      billingRedirect("relink_required");
    }

    billingRedirect("portal_failed");
  }

  redirect(portalUrl);
}

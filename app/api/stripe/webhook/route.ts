import { env } from "@/lib/env";
import {
  assertStripeWebhookConfigured,
  extractBillingUpdateFromStripeEvent,
  type StripeEvent,
  verifyStripeWebhookSignature,
} from "@/lib/stripe-billing";
import { updateAccountBillingRecord } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  try {
    assertStripeWebhookConfigured();

    if (!verifyStripeWebhookSignature(rawBody, signature, env.stripeWebhookSecret!)) {
      return Response.json({ error: "Invalid Stripe signature" }, { status: 400 });
    }
  } catch (error) {
    console.error("Stripe webhook verification is not configured", {
      error: error instanceof Error ? error.message : error,
    });

    return Response.json({ error: "Stripe webhook verification unavailable" }, { status: 500 });
  }

  let event: unknown;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid Stripe payload" }, { status: 400 });
  }

  const update = extractBillingUpdateFromStripeEvent(event as StripeEvent);

  if (!update) {
    return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    await updateAccountBillingRecord(update.accountId, {
      billingStatus: update.billingStatus,
      stripeCustomerId: update.stripeCustomerId,
      stripeSubscriptionId: update.stripeSubscriptionId,
      stripePriceId: update.stripePriceId,
      trialEndsAt: update.trialEndsAt,
    });
  } catch (error) {
    console.error("Stripe webhook billing update failed", {
      accountId: update.accountId,
      error: error instanceof Error ? error.message : error,
    });

    return Response.json({ error: "Billing update failed" }, { status: 500 });
  }

  return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
}

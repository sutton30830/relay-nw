import { env } from "@/lib/env";
import {
  notifyAdminOperationalIssue,
  notifyOwnerBillingPaymentFailed,
  notifyOwnerBillingRecovered,
  notifyOwnerSubscriptionScheduledToEnd,
} from "@/lib/email";
import {
  assertStripeWebhookConfigured,
  billingUpdateFromSubscription,
  getStripeEventIdentity,
  mapStripeSubscriptionStatus,
  retrieveStripeSubscription,
  stripeSubscriptionSnapshot,
  type StripeEvent,
  verifyStripeWebhookSignature,
} from "@/lib/stripe-billing";
import {
  accountExists,
  claimStripeEvent,
  markStripeEventFailed,
  markStripeEventIgnored,
  markStripeEventProcessed,
  getAccountBillingRecord,
  getAccountConfigByAccountId,
  resolveAccountIdByStripeCustomerId,
  resolveAccountIdByStripeSubscriptionId,
  updateAccountBillingRecord,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SUPPORTED_STRIPE_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.paid",
]);

function sanitizedErrorCode(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "stripe_webhook_processing_failed";
}

async function resolveStripeAccount(input: {
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  metadataAccountId: string | null;
}) {
  const bySubscription = await resolveAccountIdByStripeSubscriptionId(input.stripeSubscriptionId);
  if (bySubscription) {
    return { accountId: bySubscription, method: "stored_subscription" };
  }

  const byCustomer = await resolveAccountIdByStripeCustomerId(input.stripeCustomerId);
  if (byCustomer) {
    return { accountId: byCustomer, method: "stored_customer" };
  }

  if (input.metadataAccountId && await accountExists(input.metadataAccountId)) {
    return { accountId: input.metadataAccountId, method: "metadata" };
  }

  return { accountId: null, method: "unresolved" };
}

async function currentSubscriptionFor(input: {
  eventType: string;
  object: Record<string, unknown>;
  stripeSubscriptionId: string | null;
}) {
  if (input.stripeSubscriptionId) {
    return retrieveStripeSubscription(input.stripeSubscriptionId);
  }

  if (input.eventType.startsWith("customer.subscription.")) {
    return stripeSubscriptionSnapshot(input.object);
  }

  return null;
}

function isInvoicePaid(object: Record<string, unknown>) {
  return object.paid === true || object.status === "paid";
}

function getCheckoutAssociation(object: Record<string, unknown>) {
  const customerId = typeof object.customer === "string" ? object.customer : null;
  const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
  const paymentIntentId = typeof object.payment_intent === "string" ? object.payment_intent : null;
  const setupIntentId = typeof object.setup_intent === "string" ? object.setup_intent : null;

  return { customerId, subscriptionId, paymentIntentId, setupIntentId };
}

function checkoutChargeType(object: Record<string, unknown>) {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  return typeof (metadata as Record<string, unknown>).charge_type === "string"
    ? (metadata as Record<string, unknown>).charge_type
    : null;
}

function expectedStripeLivemode() {
  if (env.stripeSecretKey?.startsWith("sk_live_")) return true;
  if (env.stripeSecretKey?.startsWith("sk_test_")) return false;
  return null;
}

async function notifyBillingAttention(input: {
  accountId: string;
  eventId: string;
  eventType: string;
  subscriptionId: string;
  previousAttentionSince: string | null;
  recovered: boolean;
  scheduledToCancel: boolean;
  currentPeriodEnd: string | null;
}) {
  let account = null;

  try {
    account = await getAccountConfigByAccountId(input.accountId);
  } catch (error) {
    console.error("Stripe billing notification account lookup failed after billing state update", {
      eventId: input.eventId,
      accountId: input.accountId,
      error: error instanceof Error ? error.message : error,
    });
  }

  if (input.recovered && input.previousAttentionSince && account) {
    try {
      await notifyOwnerBillingRecovered({ account });
    } catch (emailError) {
      console.error("Stripe billing recovery owner email failed after billing state update", {
        eventId: input.eventId,
        error: emailError instanceof Error ? emailError.message : emailError,
      });
    }
  }

  if (
    input.scheduledToCancel &&
    input.eventType === "customer.subscription.updated" &&
    account
  ) {
    try {
      await notifyOwnerSubscriptionScheduledToEnd({
        account,
        currentPeriodEnd: input.currentPeriodEnd,
      });
    } catch (emailError) {
      console.error("Stripe cancel-scheduled owner email failed after billing state update", {
        eventId: input.eventId,
        error: emailError instanceof Error ? emailError.message : emailError,
      });
    }
  }

  if (input.eventType === "invoice.payment_failed" || input.eventType === "invoice.payment_action_required") {
    if (account) {
      try {
        await notifyOwnerBillingPaymentFailed({
          account,
          eventType: input.eventType,
        });
      } catch (emailError) {
        console.error("Stripe payment-attention owner email failed after billing state update", {
          eventId: input.eventId,
          error: emailError instanceof Error ? emailError.message : emailError,
        });
      }
    }

    try {
      await notifyAdminOperationalIssue({
        account,
        issue: "Stripe billing needs payment attention",
        detail: `Stripe event ${input.eventType} for subscription ${input.subscriptionId}`,
        correlationId: input.eventId,
      });
    } catch (emailError) {
      console.error("Stripe billing alert failed after billing state update", {
        eventId: input.eventId,
        error: emailError instanceof Error ? emailError.message : emailError,
      });
    }
  }
}

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

  const stripeEvent = event as StripeEvent;
  const identity = getStripeEventIdentity(stripeEvent);

  if (!identity.eventId || !identity.eventType || !identity.object) {
    return Response.json({ error: "Invalid Stripe event" }, { status: 400 });
  }

  const claim = await claimStripeEvent({
    eventId: identity.eventId,
    eventType: identity.eventType,
    eventCreatedAt: identity.eventCreatedAt,
    livemode: identity.livemode,
    stripeCustomerId: identity.stripeCustomerId,
    stripeSubscriptionId: identity.stripeSubscriptionId,
  });

  if (claim.status === "duplicate" || claim.status === "already_processing") {
    return Response.json(
      { received: true, duplicate: true, processingStatus: claim.status },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const markContext = {
    eventId: identity.eventId,
    stripeCustomerId: identity.stripeCustomerId,
    stripeSubscriptionId: identity.stripeSubscriptionId,
  };

  try {
    const expectedLive = expectedStripeLivemode();
    if (expectedLive !== null && identity.livemode !== expectedLive) {
      await markStripeEventIgnored({ ...markContext, reason: "livemode_mismatch" });
      return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (!SUPPORTED_STRIPE_EVENTS.has(identity.eventType)) {
      await markStripeEventIgnored({ ...markContext, reason: "unsupported_event_type" });
      return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const resolution = await resolveStripeAccount(identity);
    if (!resolution.accountId) {
      await markStripeEventIgnored({ ...markContext, reason: "account_unresolved" });
      return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const accountContext = { ...markContext, accountId: resolution.accountId };

    if (identity.eventType === "checkout.session.completed") {
      const association = getCheckoutAssociation(identity.object);
      if (checkoutChargeType(identity.object) === "setup_fee") {
        if (identity.object.payment_status !== "paid") {
          await markStripeEventIgnored({ ...accountContext, reason: "setup_fee_not_paid" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }

        const setupFeeUpdate = {
          setupFeeStatus: "paid",
          setupFeeCheckoutSessionId: identity.object.id as string,
          setupFeePaymentIntentId: association.paymentIntentId,
          setupFeePaidAt: new Date().toISOString(),
        } as const;
        await updateAccountBillingRecord(
          resolution.accountId,
          association.customerId
            ? { ...setupFeeUpdate, stripeCustomerId: association.customerId }
            : setupFeeUpdate,
        );
        await markStripeEventProcessed({
          ...accountContext,
          stripeCustomerId: association.customerId,
        });
        return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
      }

      if (checkoutChargeType(identity.object) === "save_card") {
        if (!association.customerId || !association.setupIntentId) {
          await markStripeEventIgnored({ ...accountContext, reason: "save_card_missing_customer_or_setup_intent" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }

        await updateAccountBillingRecord(resolution.accountId, {
          stripeCustomerId: association.customerId,
        });
        await markStripeEventProcessed({ ...accountContext, stripeCustomerId: association.customerId });
        return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
      }

      if (!association.customerId || !association.subscriptionId) {
        await markStripeEventIgnored({ ...accountContext, reason: "checkout_missing_customer_or_subscription" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }

      await updateAccountBillingRecord(resolution.accountId, {
        stripeCustomerId: association.customerId,
        stripeSubscriptionId: association.subscriptionId,
        stripePriceId: env.stripePriceId ?? null,
      });
      await markStripeEventProcessed({
        ...accountContext,
        stripeCustomerId: association.customerId,
        stripeSubscriptionId: association.subscriptionId,
      });
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const subscription = await currentSubscriptionFor({
      eventType: identity.eventType,
      object: identity.object,
      stripeSubscriptionId: identity.stripeSubscriptionId,
    });

    if (!subscription) {
      await markStripeEventIgnored({ ...accountContext, reason: "subscription_unavailable" });
      return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const existingBilling = await getAccountBillingRecord(resolution.accountId);
    const paid = identity.eventType === "invoice.paid" && isInvoicePaid(identity.object);
    const update = billingUpdateFromSubscription(resolution.accountId, subscription, { paid });
    const eventStatus = identity.eventType === "customer.subscription.deleted"
      ? "canceled"
      : identity.eventType === "invoice.payment_failed" || identity.eventType === "invoice.payment_action_required"
        ? "past_due"
        : mapStripeSubscriptionStatus(subscription.status);

    await updateAccountBillingRecord(resolution.accountId, {
      ...update,
      billingStatus: eventStatus,
      billingAttentionSince: eventStatus === "past_due"
        ? existingBilling.billingAttentionSince ?? new Date().toISOString()
        : update.billingAttentionSince,
      canceledAt: eventStatus === "canceled" ? new Date().toISOString() : undefined,
    });

    await notifyBillingAttention({
      accountId: resolution.accountId,
      eventId: identity.eventId,
      eventType: identity.eventType,
      subscriptionId: subscription.id,
      previousAttentionSince: existingBilling.billingAttentionSince,
      recovered: eventStatus !== "past_due" && update.billingAttentionSince === null,
      scheduledToCancel: subscription.cancelAtPeriodEnd && !existingBilling.cancelAtPeriodEnd,
      currentPeriodEnd: subscription.currentPeriodEnd,
    });

    if (eventStatus === "canceled") {
      await notifyAdminOperationalIssue({
        account: await getAccountConfigByAccountId(resolution.accountId),
        issue: "Subscription canceled",
        detail: "Stripe reported that this customer's subscription was canceled.",
        correlationId: identity.eventId,
      });
    }

    await markStripeEventProcessed({
      eventId: identity.eventId,
      accountId: resolution.accountId,
      stripeCustomerId: subscription.customerId ?? identity.stripeCustomerId,
      stripeSubscriptionId: subscription.id,
    });
  } catch (error) {
    console.error("Stripe webhook billing update failed", {
      eventId: identity.eventId,
      eventType: identity.eventType,
      error: error instanceof Error ? error.message : error,
    });

    try {
      await markStripeEventFailed({ ...markContext, errorCode: sanitizedErrorCode(error) });
    } catch (markError) {
      console.error("Stripe webhook event failure marker failed", {
        eventId: identity.eventId,
        error: markError instanceof Error ? markError.message : markError,
      });
    }

    return Response.json({ error: "Billing update failed" }, { status: 500 });
  }

  return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
}

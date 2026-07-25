import { env } from "@/lib/env";
import {
  notifyAdminOperationalIssue,
  notifyOwnerBillingPaymentFailed,
  notifyOwnerBillingRecovered,
  notifyOwnerSubscriptionScheduledToEnd,
  notifyOwnerTrialEnding,
} from "@/lib/email";
import {
  assertStripeObjectMode,
  assertStripeSubscriptionPrice,
  assertStripeWebhookConfigured,
  billingDatesFromPaidInvoice,
  billingUpdateFromSubscription,
  getStripeEventIdentity,
  mapStripeSubscriptionStatus,
  expectedStripeLivemode,
  reconcileSetupFeeStateFromPayment,
  retrieveStripeCustomerBillingProfile,
  retrieveStripePaymentIntent,
  retrieveStripeSetupIntent,
  retrieveStripeSubscription,
  setStripeCustomerDefaultPaymentMethod,
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
  resolveAccountIdBySetupFeePaymentIntentId,
  updateAccountBillingRecord,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SUPPORTED_STRIPE_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.finalization_failed",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.paid",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.closed",
  "customer.deleted",
  "customer.updated",
  "payment_method.attached",
  "payment_method.detached",
  "setup_intent.succeeded",
  "setup_intent.setup_failed",
]);

type PaymentAttentionEvent =
  | "invoice.finalization_failed"
  | "invoice.payment_failed"
  | "invoice.payment_action_required";

function isPaymentAttentionEvent(value: string): value is PaymentAttentionEvent {
  return (
    value === "invoice.finalization_failed" ||
    value === "invoice.payment_failed" ||
    value === "invoice.payment_action_required"
  );
}

function hasConflictingAccountMetadata(
  object: { metadataAccountId?: string | null },
  accountId: string,
) {
  return Boolean(
    object.metadataAccountId &&
    object.metadataAccountId !== accountId,
  );
}

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
  stripePaymentIntentId: string | null;
}) {
  const [bySubscription, byCustomer, byPayment, metadataExists] = await Promise.all([
    resolveAccountIdByStripeSubscriptionId(input.stripeSubscriptionId),
    resolveAccountIdByStripeCustomerId(input.stripeCustomerId),
    resolveAccountIdBySetupFeePaymentIntentId(input.stripePaymentIntentId),
    input.metadataAccountId ? accountExists(input.metadataAccountId) : Promise.resolve(false),
  ]);
  const candidates = [
    ["stored_subscription", bySubscription],
    ["stored_customer", byCustomer],
    ["stored_setup_payment", byPayment],
    ["metadata", metadataExists ? input.metadataAccountId : null],
  ].filter((candidate): candidate is [string, string] => Boolean(candidate[1]));
  const accountIds = new Set(candidates.map(([, accountId]) => accountId));

  if (accountIds.size > 1) {
    return { accountId: null, method: "conflict" };
  }

  const accountId = candidates[0]?.[1] ?? null;
  return {
    accountId,
    method: accountId ? candidates.map(([method]) => method).join("+") : "unresolved",
  };
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

async function notifyBillingAttention(input: {
  accountId: string;
  eventId: string;
  eventType: string;
  subscriptionId: string;
  previousAttentionSince: string | null;
  recovered: boolean;
  scheduledToCancel: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  paymentNeedsAttention: boolean;
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

  if (input.paymentNeedsAttention && isPaymentAttentionEvent(input.eventType)) {
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

  if (input.eventType === "customer.subscription.trial_will_end" && account) {
    try {
      await notifyOwnerTrialEnding({
        account,
        trialEndsAt: input.trialEndsAt,
      });
    } catch (emailError) {
      console.error("Stripe trial-ending owner email failed after billing state update", {
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

  let claim: Awaited<ReturnType<typeof claimStripeEvent>>;
  try {
    claim = await claimStripeEvent({
      eventId: identity.eventId,
      eventType: identity.eventType,
      eventCreatedAt: identity.eventCreatedAt,
      livemode: identity.livemode,
      stripeCustomerId: identity.stripeCustomerId,
      stripeSubscriptionId: identity.stripeSubscriptionId,
    });
  } catch (error) {
    console.error("Stripe webhook event claim failed", {
      eventId: identity.eventId,
      eventType: identity.eventType,
      error: error instanceof Error ? error.message : error,
    });
    return Response.json(
      { error: "Billing event claim unavailable", retry: true },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "60",
        },
      },
    );
  }

  if (claim.status === "already_processing") {
    return Response.json(
      { received: false, retry: true, processingStatus: claim.status },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "60",
        },
      },
    );
  }

  if (claim.status === "duplicate") {
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
      await markStripeEventIgnored({
        ...markContext,
        reason: resolution.method === "conflict"
          ? "account_resolution_conflict"
          : "account_unresolved",
      });
      return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const accountContext = { ...markContext, accountId: resolution.accountId };

    if (identity.eventType === "customer.deleted") {
      await updateAccountBillingRecord(resolution.accountId, {
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripePriceId: null,
        stripeSubscriptionStatus: null,
        billingSetupCheckoutSessionId: null,
        stripeSetupIntentId: null,
        stripeSetupIntentStatus: null,
        stripeDefaultPaymentMethodId: null,
        paymentMethodUpdatedAt: identity.eventCreatedAt ?? new Date().toISOString(),
        billingStatus: "canceled",
        cancelAtPeriodEnd: false,
        canceledAt: identity.eventCreatedAt ?? new Date().toISOString(),
      });
      await markStripeEventProcessed(accountContext);
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (identity.eventType === "checkout.session.expired") {
      const existing = await getAccountBillingRecord(resolution.accountId);
      if (
        checkoutChargeType(identity.object) === "setup_fee" &&
        existing.setupFeeCheckoutSessionId === identity.object.id &&
        existing.setupFeeStatus === "due"
      ) {
        await updateAccountBillingRecord(resolution.accountId, { setupFeeCheckoutSessionId: null });
      }
      if (
        checkoutChargeType(identity.object) === "billing_payment_method" &&
        existing.billingSetupCheckoutSessionId === identity.object.id
      ) {
        await updateAccountBillingRecord(resolution.accountId, { billingSetupCheckoutSessionId: null });
      }
      await markStripeEventProcessed(accountContext);
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (
      identity.eventType === "customer.updated" ||
      identity.eventType === "payment_method.attached" ||
      identity.eventType === "payment_method.detached"
    ) {
      if (!identity.stripeCustomerId) {
        await markStripeEventIgnored({ ...accountContext, reason: "customer_unavailable" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }
      const customer = await retrieveStripeCustomerBillingProfile(identity.stripeCustomerId);
      assertStripeObjectMode(customer.livemode, "Stripe customer");
      await updateAccountBillingRecord(resolution.accountId, {
        stripeCustomerId: customer.id,
        stripeDefaultPaymentMethodId: customer.defaultPaymentMethodId,
        paymentMethodUpdatedAt: identity.eventCreatedAt ?? new Date().toISOString(),
      });
      await markStripeEventProcessed(accountContext);
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (
      identity.eventType === "setup_intent.succeeded" ||
      identity.eventType === "setup_intent.setup_failed"
    ) {
      const setupIntentId = typeof identity.object.id === "string" ? identity.object.id : null;
      if (!setupIntentId) {
        await markStripeEventIgnored({ ...accountContext, reason: "setup_intent_unavailable" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }
      const setupIntent = await retrieveStripeSetupIntent(setupIntentId);
      assertStripeObjectMode(setupIntent.livemode, "Stripe SetupIntent");
      if (hasConflictingAccountMetadata(setupIntent, resolution.accountId)) {
        await markStripeEventIgnored({ ...accountContext, reason: "stripe_metadata_mismatch" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }
      const existing = await getAccountBillingRecord(resolution.accountId);
      let defaultPaymentMethodId = existing.stripeDefaultPaymentMethodId;
      if (
        setupIntent.status === "succeeded" &&
        setupIntent.customerId &&
        setupIntent.paymentMethodId
      ) {
        const customer = await setStripeCustomerDefaultPaymentMethod({
          customerId: setupIntent.customerId,
          paymentMethodId: setupIntent.paymentMethodId,
          idempotencyKey: `relay-default-payment-method:${resolution.accountId}:${setupIntent.id}`,
        });
        assertStripeObjectMode(customer.livemode, "Stripe customer");
        defaultPaymentMethodId = customer.defaultPaymentMethodId;
      }
      await updateAccountBillingRecord(resolution.accountId, {
        stripeCustomerId: setupIntent.customerId ?? identity.stripeCustomerId,
        stripeSetupIntentId: setupIntent.id,
        stripeSetupIntentStatus: setupIntent.status,
        stripeDefaultPaymentMethodId: defaultPaymentMethodId,
        paymentMethodUpdatedAt: identity.eventCreatedAt ?? new Date().toISOString(),
      });
      await markStripeEventProcessed(accountContext);
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (
      identity.eventType === "charge.refunded" ||
      identity.eventType === "refund.created" ||
      identity.eventType === "refund.updated" ||
      identity.eventType === "refund.failed" ||
      identity.eventType === "charge.dispute.created" ||
      identity.eventType === "charge.dispute.closed"
    ) {
      if (!identity.stripePaymentIntentId) {
        await markStripeEventIgnored({ ...accountContext, reason: "setup_payment_intent_unavailable" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }

      const existing = await getAccountBillingRecord(resolution.accountId);
      if (identity.stripePaymentIntentId !== existing.setupFeePaymentIntentId) {
        await markStripeEventIgnored({ ...accountContext, reason: "non_setup_fee_payment_intent" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }

      const payment = await retrieveStripePaymentIntent(identity.stripePaymentIntentId);
      assertStripeObjectMode(payment.livemode, "Stripe PaymentIntent");
      if (hasConflictingAccountMetadata(payment, resolution.accountId)) {
        await markStripeEventIgnored({ ...accountContext, reason: "stripe_metadata_mismatch" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }
      const eventDisputeStatus = identity.eventType.startsWith("charge.dispute.")
        ? typeof identity.object.status === "string" ? identity.object.status : identity.eventType.endsWith("created") ? "needs_response" : null
        : null;
      const setupFeeState = reconcileSetupFeeStateFromPayment(
        {
          ...payment,
          disputeStatus: eventDisputeStatus ?? payment.disputeStatus,
          disputed: identity.eventType === "charge.dispute.created" || payment.disputed,
        },
        existing,
      );
      const hasFinancialLoss = setupFeeState.setupFeeRefundedCents > 0 ||
        setupFeeState.setupFeeStatus === "charged_back";
      await updateAccountBillingRecord(resolution.accountId, {
        ...setupFeeState,
        setupFeeRefundedAt: hasFinancialLoss
          ? existing.setupFeeRefundedAt ?? identity.eventCreatedAt ?? new Date().toISOString()
          : existing.setupFeeRefundedAt,
      });
      await markStripeEventProcessed(accountContext);
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (identity.eventType === "checkout.session.completed") {
      const association = getCheckoutAssociation(identity.object);
      if (checkoutChargeType(identity.object) === "setup_fee") {
        if (identity.object.payment_status !== "paid" || !association.paymentIntentId) {
          await markStripeEventIgnored({ ...accountContext, reason: "setup_fee_not_paid" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }

        const payment = await retrieveStripePaymentIntent(association.paymentIntentId);
        assertStripeObjectMode(payment.livemode, "Stripe PaymentIntent");
        if (hasConflictingAccountMetadata(payment, resolution.accountId)) {
          await markStripeEventIgnored({ ...accountContext, reason: "stripe_metadata_mismatch" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }
        const existing = await getAccountBillingRecord(resolution.accountId);
        const setupFeeState = reconcileSetupFeeStateFromPayment(payment, existing);
        if (
          payment.status !== "succeeded" ||
          setupFeeState.setupFeeStatus !== "paid"
        ) {
          await markStripeEventIgnored({ ...accountContext, reason: "setup_fee_terms_mismatch" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }
        if (
          association.customerId &&
          payment.customerId &&
          association.customerId !== payment.customerId
        ) {
          await markStripeEventIgnored({ ...accountContext, reason: "stripe_customer_mismatch" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }
        const customerId = association.customerId ?? payment.customerId;
        let defaultPaymentMethodId: string | null = null;
        if (customerId && payment.paymentMethodId) {
          const customer = await setStripeCustomerDefaultPaymentMethod({
            customerId,
            paymentMethodId: payment.paymentMethodId,
            idempotencyKey: `relay-default-payment-method:${resolution.accountId}:${payment.id}`,
          });
          assertStripeObjectMode(customer.livemode, "Stripe customer");
          defaultPaymentMethodId = customer.defaultPaymentMethodId;
        }
        const setupFeeUpdate = {
          setupFeeStatus: setupFeeState.setupFeeStatus,
          setupFeeCheckoutSessionId: identity.object.id as string,
          setupFeePaymentIntentId: payment.id,
          setupFeePaidAt: identity.eventCreatedAt ?? new Date().toISOString(),
          stripeDefaultPaymentMethodId: defaultPaymentMethodId,
          paymentMethodUpdatedAt: identity.eventCreatedAt ?? new Date().toISOString(),
        } as const;
        await updateAccountBillingRecord(
          resolution.accountId,
          customerId
            ? { ...setupFeeUpdate, stripeCustomerId: customerId }
            : setupFeeUpdate,
        );
        await markStripeEventProcessed({
          ...accountContext,
          stripeCustomerId: customerId,
        });
        return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
      }

      if (checkoutChargeType(identity.object) === "billing_payment_method") {
        if (!association.setupIntentId) {
          await markStripeEventIgnored({ ...accountContext, reason: "setup_intent_unavailable" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }
        const setupIntent = await retrieveStripeSetupIntent(association.setupIntentId);
        assertStripeObjectMode(setupIntent.livemode, "Stripe SetupIntent");
        if (hasConflictingAccountMetadata(setupIntent, resolution.accountId)) {
          await markStripeEventIgnored({ ...accountContext, reason: "stripe_metadata_mismatch" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }
        const customerId = association.customerId ?? setupIntent.customerId;
        if (
          association.customerId &&
          setupIntent.customerId &&
          association.customerId !== setupIntent.customerId
        ) {
          await markStripeEventIgnored({ ...accountContext, reason: "stripe_customer_mismatch" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }
        if (setupIntent.status !== "succeeded" || !customerId || !setupIntent.paymentMethodId) {
          await updateAccountBillingRecord(resolution.accountId, {
            billingSetupCheckoutSessionId: identity.object.id as string,
            stripeSetupIntentId: setupIntent.id,
            stripeSetupIntentStatus: setupIntent.status,
            paymentMethodUpdatedAt: identity.eventCreatedAt ?? new Date().toISOString(),
          });
          await markStripeEventIgnored({ ...accountContext, reason: "payment_method_setup_incomplete" });
          return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
        }
        const customer = await setStripeCustomerDefaultPaymentMethod({
          customerId,
          paymentMethodId: setupIntent.paymentMethodId,
          idempotencyKey: `relay-default-payment-method:${resolution.accountId}:${setupIntent.id}`,
        });
        assertStripeObjectMode(customer.livemode, "Stripe customer");
        await updateAccountBillingRecord(resolution.accountId, {
          stripeCustomerId: customer.id,
          billingSetupCheckoutSessionId: identity.object.id as string,
          stripeSetupIntentId: setupIntent.id,
          stripeSetupIntentStatus: setupIntent.status,
          stripeDefaultPaymentMethodId: customer.defaultPaymentMethodId,
          paymentMethodUpdatedAt: identity.eventCreatedAt ?? new Date().toISOString(),
        });
        await markStripeEventProcessed({
          ...accountContext,
          stripeCustomerId: customer.id,
        });
        return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
      }

      if (!association.customerId || !association.subscriptionId) {
        await markStripeEventIgnored({ ...accountContext, reason: "checkout_missing_customer_or_subscription" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }

      const checkoutSubscription = await retrieveStripeSubscription(association.subscriptionId);
      assertStripeObjectMode(checkoutSubscription.livemode, "Stripe subscription");
      assertStripeSubscriptionPrice(checkoutSubscription.priceId, "Stripe subscription");
      if (
        checkoutSubscription.customerId !== association.customerId ||
        checkoutSubscription.metadataAccountId !== resolution.accountId
      ) {
        await markStripeEventIgnored({ ...accountContext, reason: "subscription_identity_mismatch" });
        return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
      }

      await updateAccountBillingRecord(resolution.accountId, {
        stripeCustomerId: checkoutSubscription.customerId,
        stripeSubscriptionId: checkoutSubscription.id,
        stripePriceId: checkoutSubscription.priceId,
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
    assertStripeObjectMode(subscription.livemode, "Stripe subscription");
    assertStripeSubscriptionPrice(subscription.priceId, "Stripe subscription");
    if (
      (subscription.metadataAccountId &&
        subscription.metadataAccountId !== resolution.accountId) ||
      (identity.stripeCustomerId &&
        subscription.customerId &&
        identity.stripeCustomerId !== subscription.customerId)
    ) {
      await markStripeEventIgnored({ ...accountContext, reason: "subscription_identity_mismatch" });
      return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const existingBilling = await getAccountBillingRecord(resolution.accountId);
    if (
      existingBilling.stripeSubscriptionId &&
      existingBilling.stripeSubscriptionId !== subscription.id
    ) {
      await markStripeEventIgnored({ ...accountContext, reason: "superseded_subscription" });
      return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const update = billingUpdateFromSubscription(resolution.accountId, subscription);
    const paidInvoiceDates = identity.eventType === "invoice.paid"
      ? billingDatesFromPaidInvoice(identity.object)
      : null;
    const subscriptionStatus = mapStripeSubscriptionStatus(subscription.status);
    const paymentAttentionEvent = isPaymentAttentionEvent(identity.eventType);
    const paymentNeedsAttention =
      paymentAttentionEvent && subscriptionStatus !== "canceled";
    const eventStatus = identity.eventType === "customer.subscription.deleted"
      ? "canceled"
      : paymentNeedsAttention
        ? "past_due"
        : subscriptionStatus;

    await updateAccountBillingRecord(resolution.accountId, {
      ...update,
      ...(paidInvoiceDates ?? {}),
      billingStatus: eventStatus,
      billingAttentionSince: eventStatus === "past_due"
        ? existingBilling.billingAttentionSince ?? new Date().toISOString()
        : update.billingAttentionSince,
      canceledAt: eventStatus === "canceled"
        ? identity.eventCreatedAt ?? new Date().toISOString()
        : undefined,
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
      trialEndsAt: subscription.trialEndsAt,
      paymentNeedsAttention,
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

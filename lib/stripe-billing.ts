import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import type { AccountBillingStatus, StripeSubscriptionStatus } from "@/lib/billing";

export type StripeCheckoutSessionInput = {
  accountId: string;
  accountSlug: string;
  ownerEmail: string | null;
  stripeCustomerId: string | null;
  idempotencyKey: string;
  trialPeriodDays?: number;
};

export type StripeCheckoutSession = {
  id: string;
  url: string;
};

export type StripeSetupFeeCheckoutSessionInput = {
  accountId: string;
  accountSlug: string;
  ownerEmail: string | null;
  stripeCustomerId: string | null;
  setupFeeCents: number;
  idempotencyKey: string;
};

export type StripeSaveCardCheckoutSessionInput = {
  accountId: string;
  accountSlug: string;
  ownerEmail: string | null;
  stripeCustomerId: string | null;
  idempotencyKey: string;
};

export type StripePortalSessionInput = {
  stripeCustomerId: string;
  returnUrl: string;
};

export type StripePortalSession = {
  id: string;
  url: string;
};

export type StripeSubscriptionCreation = {
  subscription: StripeSubscriptionSnapshot;
  paymentActionRequired: boolean;
  hostedInvoiceUrl: string | null;
};

export type StripeBillingUpdate = {
  accountId: string;
  billingStatus: AccountBillingStatus;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripePriceId?: string | null;
  stripeSubscriptionStatus?: StripeSubscriptionStatus | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  firstPaidAt?: string | null;
  guaranteeEndsAt?: string | null;
  billingAttentionSince?: string | null;
  canceledAt?: string | null;
};

export type StripeEvent = {
  id?: string;
  type?: string;
  created?: number;
  livemode?: boolean;
  data?: {
    object?: Record<string, unknown>;
  };
};

export type StripeEventObject = Record<string, unknown>;

export type StripeEventIdentity = {
  eventId: string | null;
  eventType: string | null;
  eventCreatedAt: string | null;
  livemode: boolean;
  object: StripeEventObject | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePaymentIntentId: string | null;
  metadataAccountId: string | null;
};

export type StripePaymentIntentSnapshot = {
  id: string;
  customerId: string | null;
  paymentMethodId: string | null;
  status: string | null;
  amount: number;
  amountReceived: number;
  amountRefunded: number;
  disputed: boolean;
};

export type StripeSetupCheckoutSnapshot = {
  id: string;
  customerId: string | null;
  paymentIntent: StripePaymentIntentSnapshot | null;
  paymentStatus: string | null;
};

export type StripeSubscriptionSnapshot = {
  id: string;
  customerId: string | null;
  status: StripeSubscriptionStatus | null;
  priceId: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 60 * 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function paymentIntentSnapshot(body: Record<string, unknown>): StripePaymentIntentSnapshot {
  const id = stringValue(body.id);
  if (!id) throw new Error("Stripe payment data did not include a PaymentIntent id.");
  const charge = body.latest_charge && typeof body.latest_charge === "object"
    ? body.latest_charge as Record<string, unknown>
    : null;
  return {
    id,
    customerId: stringValue(body.customer),
    paymentMethodId: stringValue(body.payment_method),
    status: stringValue(body.status),
    amount: numberValue(body.amount) ?? 0,
    amountReceived: numberValue(body.amount_received) ?? 0,
    amountRefunded: charge ? numberValue(charge.amount_refunded) ?? 0 : 0,
    disputed: charge?.disputed === true,
  };
}

function metadataAccountId(object: Record<string, unknown>) {
  const metadata = object.metadata;

  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  return stringValue((metadata as Record<string, unknown>).account_id);
}

function firstSubscriptionPriceId(subscription: Record<string, unknown>) {
  const items = subscription.items;

  if (!items || typeof items !== "object") {
    return null;
  }

  const data = (items as Record<string, unknown>).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") {
    return null;
  }

  const price = (data[0] as Record<string, unknown>).price;
  if (!price || typeof price !== "object") {
    return null;
  }

  return stringValue((price as Record<string, unknown>).id);
}

function firstSubscriptionItemValue(subscription: Record<string, unknown>, key: string) {
  const items = subscription.items;

  if (!items || typeof items !== "object") {
    return null;
  }

  const data = (items as Record<string, unknown>).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") {
    return null;
  }

  return (data[0] as Record<string, unknown>)[key] ?? null;
}

function subscriptionIdFromInvoice(invoice: Record<string, unknown>) {
  const parent = invoice.parent;
  if (parent && typeof parent === "object") {
    const subscriptionDetails = (parent as Record<string, unknown>).subscription_details;
    if (subscriptionDetails && typeof subscriptionDetails === "object") {
      const subscription = (subscriptionDetails as Record<string, unknown>).subscription;
      if (typeof subscription === "string") {
        return stringValue(subscription);
      }

      if (subscription && typeof subscription === "object") {
        return stringValue((subscription as Record<string, unknown>).id);
      }
    }
  }

  const subscription = invoice.subscription;
  if (typeof subscription === "string") {
    return stringValue(subscription);
  }

  if (subscription && typeof subscription === "object") {
    return stringValue((subscription as Record<string, unknown>).id);
  }

  return null;
}

function unixSecondsToIso(value: unknown) {
  const seconds = numberValue(value);

  if (!seconds) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

function subscriptionPeriodEnd(subscription: Record<string, unknown>) {
  return (
    unixSecondsToIso(subscription.current_period_end) ??
    unixSecondsToIso(firstSubscriptionItemValue(subscription, "current_period_end")) ??
    unixSecondsToIso(subscription.cancel_at)
  );
}

function subscriptionCancelAtPeriodEnd(subscription: Record<string, unknown>) {
  if (subscription.cancel_at_period_end === true) {
    return true;
  }

  const status = stringValue(subscription.status);
  const cancelAt = numberValue(subscription.cancel_at);

  return Boolean(cancelAt && status !== "canceled");
}

export function assertStripeCheckoutConfigured() {
  if (!env.stripeSecretKey || !env.stripePriceId) {
    throw new Error("Stripe checkout is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.");
  }
}

export function assertStripeSetupFeeConfigured() {
  if (!env.stripeSecretKey || !env.stripeSetupFeePriceId) {
    throw new Error("Stripe setup-fee checkout is not configured. Set STRIPE_SECRET_KEY and STRIPE_SETUP_FEE_PRICE_ID.");
  }
}

export function assertStripePortalConfigured() {
  if (!env.stripeSecretKey) {
    throw new Error("Stripe portal is not configured. Set STRIPE_SECRET_KEY.");
  }
}

export function assertStripeWebhookConfigured() {
  if (!env.stripeWebhookSecret) {
    throw new Error("Stripe webhook verification is not configured. Set STRIPE_WEBHOOK_SECRET.");
  }
}

export function mapStripeSubscriptionStatus(status: string | null | undefined): AccountBillingStatus {
  if (status === "active") return "active";
  if (status === "trialing") return "trialing";
  if (status === "canceled") return "canceled";
  if (
    status === "past_due" ||
    status === "unpaid" ||
    status === "incomplete" ||
    status === "incomplete_expired"
  ) {
    return "past_due";
  }

  return "not_started";
}

export function checkoutTrialPeriodDays(input: {
  billingStatus: AccountBillingStatus;
  trialEndsAt?: string | null;
  defaultTrialDays?: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const defaultTrialDays = Math.max(1, Math.round(input.defaultTrialDays ?? env.stripeTrialDays ?? 30));

  if (input.billingStatus !== "trialing") {
    return defaultTrialDays;
  }

  if (!input.trialEndsAt) {
    return defaultTrialDays;
  }

  const trialEndsAt = new Date(input.trialEndsAt);
  if (!Number.isFinite(trialEndsAt.getTime())) {
    return defaultTrialDays;
  }

  const remainingDays = Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS);

  return Math.max(0, remainingDays);
}

export async function createStripeCheckoutSession(
  input: StripeCheckoutSessionInput,
): Promise<StripeCheckoutSession> {
  assertStripeCheckoutConfigured();

  const successUrl = `${env.appBaseUrl}/setup?billing=success`;
  const cancelUrl = `${env.appBaseUrl}/setup?billing=canceled`;
  const params = new URLSearchParams({
    mode: "subscription",
    client_reference_id: input.accountId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    "line_items[0][price]": env.stripePriceId!,
    "line_items[0][quantity]": "1",
    "metadata[account_id]": input.accountId,
    "metadata[account_slug]": input.accountSlug,
    "subscription_data[metadata][account_id]": input.accountId,
    "subscription_data[metadata][account_slug]": input.accountSlug,
  });

  if (input.trialPeriodDays && input.trialPeriodDays > 0) {
    params.set("subscription_data[trial_period_days]", String(Math.round(input.trialPeriodDays)));
  }

  if (input.stripeCustomerId) {
    params.set("customer", input.stripeCustomerId);
  } else if (input.ownerEmail) {
    params.set("customer_email", input.ownerEmail);
  }

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: params,
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const message =
      typeof body.error === "object" && body.error
        ? stringValue((body.error as Record<string, unknown>).message)
        : null;
    throw new Error(message ?? `Stripe checkout failed with status ${response.status}`);
  }

  const id = stringValue(body.id);
  const url = stringValue(body.url);

  if (!id || !url) {
    throw new Error("Stripe checkout did not return a redirect URL.");
  }

  return { id, url };
}

export async function createStripeSetupFeeCheckoutSession(
  input: StripeSetupFeeCheckoutSessionInput,
): Promise<StripeCheckoutSession> {
  assertStripeSetupFeeConfigured();

  const params = new URLSearchParams({
    mode: "payment",
    client_reference_id: input.accountId,
    success_url: `${env.appBaseUrl}/settings?billing=setup_fee_success#billing`,
    cancel_url: `${env.appBaseUrl}/settings?billing=setup_fee_canceled#billing`,
    "line_items[0][price]": env.stripeSetupFeePriceId!,
    "line_items[0][quantity]": "1",
    "metadata[account_id]": input.accountId,
    "metadata[account_slug]": input.accountSlug,
    "metadata[charge_type]": "setup_fee",
    "payment_intent_data[metadata][account_id]": input.accountId,
    "payment_intent_data[metadata][charge_type]": "setup_fee",
    "payment_intent_data[setup_future_usage]": "off_session",
  });

  let usableCustomerId = input.stripeCustomerId;
  if (usableCustomerId) {
    const customerResponse = await fetch(`${STRIPE_API_BASE}/customers/${encodeURIComponent(usableCustomerId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.stripeSecretKey}` },
    });

    if (!customerResponse.ok) {
      if (customerResponse.status === 404) {
        // A customer id from the other Stripe mode, or a deleted customer,
        // must not prevent a new one-time payment from being collected.
        usableCustomerId = null;
      } else {
        const body = (await customerResponse.json().catch(() => ({}))) as Record<string, unknown>;
        const message = typeof body.error === "object" && body.error
          ? stringValue((body.error as Record<string, unknown>).message)
          : null;
        throw new Error(message ?? `Stripe customer lookup failed with status ${customerResponse.status}`);
      }
    }
  }

  if (usableCustomerId) {
    params.set("customer", usableCustomerId);
  } else if (input.ownerEmail) {
    params.set("customer_email", input.ownerEmail);
    params.set("customer_creation", "always");
  }

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: params,
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe setup-fee checkout failed with status ${response.status}`);
  }

  const id = stringValue(body.id);
  const url = stringValue(body.url);
  if (!id || !url) throw new Error("Stripe setup-fee checkout did not return a redirect URL.");

  return { id, url };
}

export async function retrieveStripeSetupCheckoutSession(sessionId: string): Promise<StripeSetupCheckoutSnapshot> {
  assertStripeSetupFeeConfigured();
  const response = await fetch(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge`,
    { headers: { Authorization: `Bearer ${env.stripeSecretKey}` } },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe checkout lookup failed with status ${response.status}`);
  }

  const id = stringValue(body.id);
  if (!id) throw new Error("Stripe checkout lookup returned no session ID.");

  const paymentIntentObject = body.payment_intent && typeof body.payment_intent === "object"
    ? body.payment_intent as Record<string, unknown>
    : null;
  const paymentIntentId = typeof body.payment_intent === "string"
    ? stringValue(body.payment_intent)
    : paymentIntentObject
      ? stringValue(paymentIntentObject.id)
      : null;

  const paymentIntent = paymentIntentObject
    ? paymentIntentSnapshot(paymentIntentObject)
    : paymentIntentId
      ? await retrieveStripePaymentIntent(paymentIntentId)
      : null;

  return {
    id,
    customerId: stringValue(body.customer) ?? paymentIntent?.customerId ?? null,
    paymentIntent,
    paymentStatus: stringValue(body.payment_status),
  };
}

export async function createStripeSaveCardCheckoutSession(
  input: StripeSaveCardCheckoutSessionInput,
): Promise<StripeCheckoutSession> {
  assertStripeCheckoutConfigured();

  const params = new URLSearchParams({
    mode: "setup",
    client_reference_id: input.accountId,
    success_url: `${env.appBaseUrl}/ops?account=${encodeURIComponent(input.accountSlug)}&kickoff=card_saved`,
    cancel_url: `${env.appBaseUrl}/ops?account=${encodeURIComponent(input.accountSlug)}&kickoff=canceled`,
    "metadata[account_id]": input.accountId,
    "metadata[account_slug]": input.accountSlug,
    "metadata[charge_type]": "save_card",
    "setup_intent_data[metadata][account_id]": input.accountId,
    "setup_intent_data[metadata][charge_type]": "save_card",
  });

  if (input.stripeCustomerId) params.set("customer", input.stripeCustomerId);
  else if (input.ownerEmail) params.set("customer_email", input.ownerEmail);

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: params,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe save-card checkout failed with status ${response.status}`);
  }
  const id = stringValue(body.id);
  const url = stringValue(body.url);
  if (!id || !url) throw new Error("Stripe save-card checkout did not return a redirect URL.");
  return { id, url };
}

export async function createStripePortalSession(
  input: StripePortalSessionInput,
): Promise<StripePortalSession> {
  assertStripePortalConfigured();

  const params = new URLSearchParams({
    customer: input.stripeCustomerId,
    return_url: input.returnUrl,
  });

  const response = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const message =
      typeof body.error === "object" && body.error
        ? stringValue((body.error as Record<string, unknown>).message)
        : null;
    throw new Error(message ?? `Stripe portal failed with status ${response.status}`);
  }

  const id = stringValue(body.id);
  const url = stringValue(body.url);

  if (!id || !url) {
    throw new Error("Stripe portal did not return a redirect URL.");
  }

  return { id, url };
}

export async function retrieveStripeSubscription(
  stripeSubscriptionId: string,
): Promise<StripeSubscriptionSnapshot> {
  if (!env.stripeSecretKey) {
    throw new Error("Stripe subscription retrieval is not configured. Set STRIPE_SECRET_KEY.");
  }

  const response = await fetch(`${STRIPE_API_BASE}/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
    },
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const message =
      typeof body.error === "object" && body.error
        ? stringValue((body.error as Record<string, unknown>).message)
        : null;
    throw new Error(message ?? `Stripe subscription retrieval failed with status ${response.status}`);
  }

  const id = stringValue(body.id);
  if (!id) {
    throw new Error("Stripe subscription retrieval did not return a subscription id.");
  }

  return stripeSubscriptionSnapshot(body);
}

export async function retrieveStripePaymentIntent(
  paymentIntentId: string,
): Promise<StripePaymentIntentSnapshot> {
  if (!env.stripeSecretKey) throw new Error("Stripe payment retrieval is not configured. Set STRIPE_SECRET_KEY.");
  const params = new URLSearchParams({ "expand[]": "latest_charge" });
  const response = await fetch(
    `${STRIPE_API_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}?${params}`,
    { headers: { Authorization: `Bearer ${env.stripeSecretKey}` } },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe payment retrieval failed with status ${response.status}`);
  }
  return paymentIntentSnapshot(body);
}

export async function retrieveStripeSetupIntent(setupIntentId: string) {
  if (!env.stripeSecretKey) throw new Error("Stripe card setup retrieval is not configured. Set STRIPE_SECRET_KEY.");
  const response = await fetch(`${STRIPE_API_BASE}/setup_intents/${encodeURIComponent(setupIntentId)}`, {
    headers: { Authorization: `Bearer ${env.stripeSecretKey}` },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message) : null;
    throw new Error(message ?? `Stripe card setup retrieval failed with status ${response.status}`);
  }
  return {
    id: stringValue(body.id),
    customerId: stringValue(body.customer),
    paymentMethodId: stringValue(body.payment_method),
    status: stringValue(body.status),
  };
}

export async function createStripeRefund(input: {
  paymentIntentId: string;
  amountCents?: number | null;
  accountId: string;
  reason: string;
  idempotencyKey: string;
}) {
  if (!env.stripeSecretKey) throw new Error("Stripe refunds are not configured. Set STRIPE_SECRET_KEY.");
  const params = new URLSearchParams({
    payment_intent: input.paymentIntentId,
    "metadata[account_id]": input.accountId,
    "metadata[refund_reason]": input.reason.slice(0, 240),
  });
  if (input.amountCents && input.amountCents > 0) params.set("amount", String(Math.round(input.amountCents)));
  const response = await fetch(`${STRIPE_API_BASE}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: params,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe refund failed with status ${response.status}`);
  }
  const id = stringValue(body.id);
  if (!id) throw new Error("Stripe refund did not return a refund id.");
  return { id, status: stringValue(body.status), amount: numberValue(body.amount) ?? 0 };
}

export async function createStripeSubscriptionFromSavedCard(input: {
  accountId: string;
  accountSlug: string;
  customerId: string;
  paymentMethodId: string;
  idempotencyKey: string;
  trialDays?: number | null;
}): Promise<StripeSubscriptionCreation> {
  assertStripeCheckoutConfigured();
  const customerParams = new URLSearchParams({
    "invoice_settings[default_payment_method]": input.paymentMethodId,
  });
  const customerResponse = await fetch(`${STRIPE_API_BASE}/customers/${encodeURIComponent(input.customerId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.stripeSecretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: customerParams,
  });
  const customerBody = (await customerResponse.json().catch(() => ({}))) as Record<string, unknown>;
  if (!customerResponse.ok) {
    const message = typeof customerBody.error === "object" && customerBody.error
      ? stringValue((customerBody.error as Record<string, unknown>).message) : null;
    throw new Error(message ?? `Stripe customer payment method update failed with status ${customerResponse.status}`);
  }
  const params = new URLSearchParams({
    customer: input.customerId,
    "items[0][price]": env.stripePriceId!,
    default_payment_method: input.paymentMethodId,
    payment_behavior: "default_incomplete",
    "payment_settings[save_default_payment_method]": "on_subscription",
    "metadata[account_id]": input.accountId,
    "metadata[account_slug]": input.accountSlug,
    "expand[]": "latest_invoice.payment_intent",
  });
  if (input.trialDays && input.trialDays > 0) params.set("trial_period_days", String(Math.round(input.trialDays)));
  const response = await fetch(`${STRIPE_API_BASE}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: params,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message) : null;
    throw new Error(message ?? `Stripe subscription creation failed with status ${response.status}`);
  }
  const invoice = body.latest_invoice && typeof body.latest_invoice === "object"
    ? body.latest_invoice as Record<string, unknown> : null;
  const paymentIntent = invoice?.payment_intent && typeof invoice.payment_intent === "object"
    ? invoice.payment_intent as Record<string, unknown> : null;
  const paymentStatus = paymentIntent ? stringValue(paymentIntent.status) : null;
  return {
    subscription: stripeSubscriptionSnapshot(body),
    paymentActionRequired: paymentStatus === "requires_action" || paymentStatus === "requires_payment_method",
    hostedInvoiceUrl: invoice ? stringValue(invoice.hosted_invoice_url) : null,
  };
}

export function setupFeeStateFromPayment(payment: StripePaymentIntentSnapshot): Pick<
  import("@/lib/billing").AccountBillingRecord,
  "setupFeeStatus" | "setupFeeRefundedCents"
> {
  const fullyRefunded = payment.amountRefunded >= Math.max(payment.amountReceived, payment.amount);
  return {
    setupFeeStatus: payment.disputed
      ? "disputed"
      : fullyRefunded
        ? "refunded"
        : payment.amountRefunded > 0
          ? "partially_refunded"
          : payment.status === "succeeded"
            ? "paid"
            : "due",
    setupFeeRefundedCents: payment.amountRefunded,
  };
}

export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
) {
  const parts = new Map(
    (signatureHeader ?? "")
      .split(",")
      .map((part) => part.split("="))
      .filter((part): part is [string, string] => part.length === 2),
  );
  const timestamp = Number(parts.get("t"));
  const signature = parts.get("v1");

  if (!Number.isFinite(timestamp) || !signature) {
    return false;
  }

  const ageSeconds = Math.abs(nowMs / 1000 - timestamp);
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function getStripeEventIdentity(event: StripeEvent): StripeEventIdentity {
  const object = event.data?.object && typeof event.data.object === "object" ? event.data.object : null;
  const eventCreatedAt = event.created ? unixSecondsToIso(event.created) : null;
  const eventType = stringValue(event.type);
  const isInvoice = eventType?.startsWith("invoice.") ?? false;
  const isSubscription = eventType?.startsWith("customer.subscription.") ?? false;
  const isCheckout = eventType?.startsWith("checkout.session.") ?? false;
  const paymentIntentId = object
    ? stringValue(object.payment_intent) ??
      (eventType?.startsWith("payment_intent.") ? stringValue(object.id) : null)
    : null;

  return {
    eventId: stringValue(event.id),
    eventType,
    eventCreatedAt,
    livemode: event.livemode === true,
    object,
    stripeCustomerId: object
      ? eventType === "customer.deleted" ? stringValue(object.id) : stringValue(object.customer)
      : null,
    stripeSubscriptionId: object
      ? isInvoice
        ? subscriptionIdFromInvoice(object)
        : isSubscription
          ? stringValue(object.id)
          : isCheckout
            ? stringValue(object.subscription)
            : null
      : null,
    stripePaymentIntentId: paymentIntentId,
    metadataAccountId: object ? metadataAccountId(object) : null,
  };
}

export function stripeSubscriptionSnapshot(subscription: Record<string, unknown>): StripeSubscriptionSnapshot {
  const id = stringValue(subscription.id);

  if (!id) {
    throw new Error("Stripe subscription is missing an id.");
  }

  return {
    id,
    customerId: stringValue(subscription.customer),
    status: normalizeStripeSubscriptionStatus(stringValue(subscription.status)),
    priceId: firstSubscriptionPriceId(subscription),
    trialEndsAt: unixSecondsToIso(subscription.trial_end),
    currentPeriodEnd: subscriptionPeriodEnd(subscription),
    cancelAtPeriodEnd: subscriptionCancelAtPeriodEnd(subscription),
  };
}

function normalizeStripeSubscriptionStatus(value: string | null | undefined): StripeSubscriptionStatus | null {
  if (
    value === "incomplete" ||
    value === "incomplete_expired" ||
    value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "canceled" ||
    value === "unpaid" ||
    value === "paused"
  ) {
    return value;
  }

  return null;
}

export function billingUpdateFromSubscription(
  accountId: string,
  subscription: StripeSubscriptionSnapshot,
  options: { nowIso?: string; paid?: boolean } = {},
): StripeBillingUpdate {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const billingStatus = mapStripeSubscriptionStatus(subscription.status);
  const isPaid = options.paid === true || billingStatus === "active" || billingStatus === "trialing";

  return {
    accountId,
    billingStatus,
    stripeCustomerId: subscription.customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: subscription.priceId,
    stripeSubscriptionStatus: subscription.status,
    trialEndsAt: subscription.trialEndsAt,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    firstPaidAt: isPaid ? nowIso : undefined,
    guaranteeEndsAt: isPaid ? new Date(Date.parse(nowIso) + 30 * 24 * 60 * 60 * 1000).toISOString() : undefined,
    billingAttentionSince: billingStatus === "past_due" ? nowIso : null,
  };
}

export function extractBillingUpdateFromStripeEvent(event: StripeEvent): StripeBillingUpdate | null {
  const object = event.data?.object;

  if (!event.type || !object) {
    return null;
  }

  if (event.type === "checkout.session.completed") {
    const accountId = metadataAccountId(object) ?? stringValue(object.client_reference_id);
    const subscriptionId = stringValue(object.subscription);

    if (!accountId || !subscriptionId) {
      return null;
    }

    return {
      accountId,
      billingStatus: "not_started",
      stripeCustomerId: stringValue(object.customer),
      stripeSubscriptionId: subscriptionId,
      stripePriceId: env.stripePriceId ?? null,
      trialEndsAt: null,
    };
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const accountId = metadataAccountId(object);

    if (!accountId) {
      return null;
    }

    return {
      accountId,
      billingStatus:
        event.type === "customer.subscription.deleted"
          ? "canceled"
          : mapStripeSubscriptionStatus(stringValue(object.status)),
      stripeCustomerId: stringValue(object.customer),
      stripeSubscriptionId: stringValue(object.id),
      stripePriceId: firstSubscriptionPriceId(object),
      trialEndsAt: unixSecondsToIso(object.trial_end),
    };
  }

  return null;
}

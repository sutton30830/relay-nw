import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import type { AccountBillingStatus, StripeSubscriptionStatus } from "@/lib/billing";

export type StripeCheckoutSessionInput = {
  accountId: string;
  accountSlug: string;
  ownerEmail: string | null;
  stripeCustomerId: string | null;
  idempotencyKey: string;
};

export type StripeCheckoutSession = {
  id: string;
  url: string;
};

export type StripePortalSessionInput = {
  stripeCustomerId: string;
  returnUrl: string;
};

export type StripePortalSession = {
  id: string;
  url: string;
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
  activatedAt?: string | null;
  firstPaidAt?: string | null;
  guaranteeEndsAt?: string | null;
  billingAttentionSince?: string | null;
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
  metadataAccountId: string | null;
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

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

  return {
    eventId: stringValue(event.id),
    eventType,
    eventCreatedAt,
    livemode: event.livemode === true,
    object,
    stripeCustomerId: object ? stringValue(object.customer) : null,
    stripeSubscriptionId: object
      ? isInvoice
        ? subscriptionIdFromInvoice(object)
        : stringValue(object.id) ?? stringValue(object.subscription)
      : null,
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
    activatedAt: isPaid ? nowIso : undefined,
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

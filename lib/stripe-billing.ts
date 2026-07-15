import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import type { AccountBillingStatus } from "@/lib/billing";

export type StripeCheckoutSessionInput = {
  accountId: string;
  accountSlug: string;
  ownerEmail: string | null;
  stripeCustomerId: string | null;
};

export type StripeCheckoutSession = {
  id: string;
  url: string;
};

export type StripeBillingUpdate = {
  accountId: string;
  billingStatus: AccountBillingStatus;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripePriceId?: string | null;
  trialEndsAt?: string | null;
};

export type StripeEvent = {
  id?: string;
  type?: string;
  data?: {
    object?: Record<string, unknown>;
  };
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

function unixSecondsToIso(value: unknown) {
  const seconds = numberValue(value);

  if (!seconds) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

export function assertStripeCheckoutConfigured() {
  if (!env.stripeSecretKey || !env.stripePriceId) {
    throw new Error("Stripe checkout is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.");
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
      billingStatus: "active",
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

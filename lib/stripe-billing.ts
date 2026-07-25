import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import type {
  AccountBillingRecord,
  AccountBillingStatus,
  StripeSubscriptionStatus,
} from "@/lib/billing";

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

export type StripeCheckoutSessionSnapshot = {
  id: string;
  url: string | null;
  status: string | null;
  paymentStatus: string | null;
};

export type StripeSetupFeeCheckoutSessionInput = {
  accountId: string;
  accountSlug: string;
  ownerEmail: string | null;
  stripeCustomerId: string | null;
  setupFeeCents: number;
  idempotencyKey: string;
};

export type StripePaymentMethodCheckoutSessionInput = {
  accountId: string;
  accountSlug: string;
  ownerEmail: string | null;
  stripeCustomerId: string | null;
  trialDays: number;
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
  metadataAccountId: string | null;
  status: string | null;
  currency: string | null;
  amount: number;
  amountReceived: number;
  amountRefunded: number;
  disputed: boolean;
  disputeStatus: string | null;
  livemode: boolean;
};

export type StripeSetupIntentSnapshot = {
  id: string;
  customerId: string | null;
  paymentMethodId: string | null;
  metadataAccountId: string | null;
  status: string | null;
  livemode: boolean;
};

export type StripeSetupCheckoutSnapshot = {
  id: string;
  customerId: string | null;
  paymentIntent: StripePaymentIntentSnapshot | null;
  setupIntent: StripeSetupIntentSnapshot | null;
  paymentStatus: string | null;
  status: string | null;
};

export type StripeSubscriptionSnapshot = {
  id: string;
  customerId: string | null;
  status: StripeSubscriptionStatus | null;
  priceId: string | null;
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  metadataAccountId: string | null;
  livemode: boolean;
};

export type StripeCustomerBillingSnapshot = {
  id: string;
  defaultPaymentMethodId: string | null;
  livemode: boolean;
};

const STRIPE_API_BASE = "https://api.stripe.com/v1";
export const RELAY_SETUP_FEE_CENTS = 15000;
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
  const dispute = charge?.dispute && typeof charge.dispute === "object"
    ? charge.dispute as Record<string, unknown>
    : null;
  return {
    id,
    customerId: stringValue(body.customer),
    paymentMethodId: stringValue(body.payment_method),
    metadataAccountId: metadataAccountId(body),
    status: stringValue(body.status),
    currency: stringValue(body.currency)?.toLowerCase() ?? null,
    amount: numberValue(body.amount) ?? 0,
    amountReceived: numberValue(body.amount_received) ?? 0,
    amountRefunded: charge ? numberValue(charge.amount_refunded) ?? 0 : 0,
    disputed: charge?.disputed === true,
    disputeStatus: dispute ? stringValue(dispute.status) : null,
    livemode: body.livemode === true,
  };
}

function setupIntentSnapshot(body: Record<string, unknown>): StripeSetupIntentSnapshot {
  const id = stringValue(body.id);
  if (!id) throw new Error("Stripe setup data did not include a SetupIntent id.");
  return {
    id,
    customerId: stringValue(body.customer),
    paymentMethodId: stringValue(body.payment_method),
    metadataAccountId: metadataAccountId(body),
    status: stringValue(body.status),
    livemode: body.livemode === true,
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

export function expectedStripeLivemode() {
  if (env.stripeSecretKey?.startsWith("sk_live_")) return true;
  if (env.stripeSecretKey?.startsWith("sk_test_")) return false;
  return null;
}

export function assertStripeObjectMode(livemode: boolean, label: string) {
  const expected = expectedStripeLivemode();
  if (expected !== null && livemode !== expected) {
    throw new Error(`${label} belongs to the wrong Stripe mode.`);
  }
}

export function assertStripeSubscriptionPrice(priceId: string | null, label: string) {
  if (!env.stripePriceId) {
    throw new Error("Stripe subscription price is not configured. Set STRIPE_PRICE_ID.");
  }
  if (priceId !== env.stripePriceId) {
    throw new Error(`${label} does not use Relay's configured $99 monthly price.`);
  }
}

export function mapStripeSubscriptionStatus(status: string | null | undefined): AccountBillingStatus {
  if (status === "active") return "active";
  if (status === "trialing") return "trialing";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  if (
    status === "past_due" ||
    status === "unpaid" ||
    status === "incomplete" ||
    status === "paused"
  ) {
    return "past_due";
  }

  return "not_started";
}

export async function createStripeCheckoutSession(
  input: StripeCheckoutSessionInput,
): Promise<StripeCheckoutSession> {
  assertStripeCheckoutConfigured();

  const successUrl = `${env.appBaseUrl}/settings?billing=success#billing`;
  const cancelUrl = `${env.appBaseUrl}/settings?billing=canceled#billing`;
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

export async function createStripeSetupFeeCheckoutSession(
  input: StripeSetupFeeCheckoutSessionInput,
): Promise<StripeCheckoutSession> {
  assertStripeSetupFeeConfigured();
  if (input.setupFeeCents !== RELAY_SETUP_FEE_CENTS) {
    throw new Error("Relay's standard setup fee must be exactly $150.");
  }

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
    "payment_method_types[0]": "card",
    "consent_collection[payment_method_reuse_agreement][position]": "auto",
    "custom_text[submit][message]":
      "Your card will be saved securely in Stripe for $99 monthly billing after your free trial. You can cancel or update it in the Stripe billing portal.",
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

export async function createStripePaymentMethodCheckoutSession(
  input: StripePaymentMethodCheckoutSessionInput,
): Promise<StripeCheckoutSession> {
  if (!env.stripeSecretKey) {
    throw new Error("Stripe payment-method setup is not configured. Set STRIPE_SECRET_KEY.");
  }

  const params = new URLSearchParams({
    mode: "setup",
    currency: "usd",
    client_reference_id: input.accountId,
    success_url: `${env.appBaseUrl}/settings?billing=payment_method_success#billing`,
    cancel_url: `${env.appBaseUrl}/settings?billing=payment_method_canceled#billing`,
    "payment_method_types[0]": "card",
    "metadata[account_id]": input.accountId,
    "metadata[account_slug]": input.accountSlug,
    "metadata[charge_type]": "billing_payment_method",
    "setup_intent_data[metadata][account_id]": input.accountId,
    "setup_intent_data[metadata][account_slug]": input.accountSlug,
    "setup_intent_data[metadata][charge_type]": "billing_payment_method",
    "consent_collection[payment_method_reuse_agreement][position]": "auto",
    "custom_text[submit][message]":
      `Nothing is charged now. Your card will be used for $99/month after your ${input.trialDays}-day trial, unless you cancel in Stripe.`,
  });

  let usableCustomerId = input.stripeCustomerId;
  if (usableCustomerId) {
    const customerResponse = await fetch(`${STRIPE_API_BASE}/customers/${encodeURIComponent(usableCustomerId)}`, {
      headers: { Authorization: `Bearer ${env.stripeSecretKey}` },
    });
    if (!customerResponse.ok) {
      if (customerResponse.status === 404) {
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
  } else {
    params.set("customer_creation", "always");
    if (input.ownerEmail) params.set("customer_email", input.ownerEmail);
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
    throw new Error(message ?? `Stripe payment-method Checkout failed with status ${response.status}`);
  }
  const id = stringValue(body.id);
  const url = stringValue(body.url);
  if (!id || !url) throw new Error("Stripe payment-method Checkout did not return a redirect URL.");
  return { id, url };
}

export async function retrieveStripeSetupCheckoutSession(sessionId: string): Promise<StripeSetupCheckoutSnapshot> {
  if (!env.stripeSecretKey) {
    throw new Error("Stripe Checkout retrieval is not configured. Set STRIPE_SECRET_KEY.");
  }
  const response = await fetch(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge.dispute&expand[]=setup_intent`,
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
  const setupIntentObject = body.setup_intent && typeof body.setup_intent === "object"
    ? body.setup_intent as Record<string, unknown>
    : null;
  const setupIntentId = typeof body.setup_intent === "string"
    ? stringValue(body.setup_intent)
    : setupIntentObject
      ? stringValue(setupIntentObject.id)
      : null;
  const setupIntent = setupIntentObject
    ? setupIntentSnapshot(setupIntentObject)
    : setupIntentId
      ? await retrieveStripeSetupIntent(setupIntentId)
      : null;

  return {
    id,
    customerId: stringValue(body.customer) ?? paymentIntent?.customerId ?? setupIntent?.customerId ?? null,
    paymentIntent,
    setupIntent,
    paymentStatus: stringValue(body.payment_status),
    status: stringValue(body.status),
  };
}

export async function retrieveStripeCheckoutSession(
  sessionId: string,
): Promise<StripeCheckoutSessionSnapshot> {
  if (!env.stripeSecretKey) {
    throw new Error("Stripe checkout retrieval is not configured. Set STRIPE_SECRET_KEY.");
  }

  const response = await fetch(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`,
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

  return {
    id,
    url: stringValue(body.url),
    status: stringValue(body.status),
    paymentStatus: stringValue(body.payment_status),
  };
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
  const params = new URLSearchParams({ "expand[]": "latest_charge.dispute" });
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

export async function retrieveStripeSetupIntent(
  setupIntentId: string,
): Promise<StripeSetupIntentSnapshot> {
  if (!env.stripeSecretKey) throw new Error("Stripe setup retrieval is not configured. Set STRIPE_SECRET_KEY.");
  const response = await fetch(
    `${STRIPE_API_BASE}/setup_intents/${encodeURIComponent(setupIntentId)}`,
    { headers: { Authorization: `Bearer ${env.stripeSecretKey}` } },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe SetupIntent retrieval failed with status ${response.status}`);
  }
  return setupIntentSnapshot(body);
}

export async function retrieveStripeCustomerBillingProfile(
  customerId: string,
): Promise<StripeCustomerBillingSnapshot> {
  if (!env.stripeSecretKey) throw new Error("Stripe customer retrieval is not configured. Set STRIPE_SECRET_KEY.");
  const response = await fetch(`${STRIPE_API_BASE}/customers/${encodeURIComponent(customerId)}`, {
    headers: { Authorization: `Bearer ${env.stripeSecretKey}` },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe customer retrieval failed with status ${response.status}`);
  }
  const id = stringValue(body.id);
  if (!id) throw new Error("Stripe customer retrieval did not return a customer id.");
  const invoiceSettings = body.invoice_settings && typeof body.invoice_settings === "object"
    ? body.invoice_settings as Record<string, unknown>
    : null;
  return {
    id,
    defaultPaymentMethodId: invoiceSettings
      ? stringValue(invoiceSettings.default_payment_method)
      : null,
    livemode: body.livemode === true,
  };
}

export async function setStripeCustomerDefaultPaymentMethod(input: {
  customerId: string;
  paymentMethodId: string;
  idempotencyKey: string;
}) {
  if (!env.stripeSecretKey) throw new Error("Stripe customer updates are not configured. Set STRIPE_SECRET_KEY.");
  const params = new URLSearchParams({
    "invoice_settings[default_payment_method]": input.paymentMethodId,
  });
  const response = await fetch(`${STRIPE_API_BASE}/customers/${encodeURIComponent(input.customerId)}`, {
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
    throw new Error(message ?? `Stripe customer update failed with status ${response.status}`);
  }
  return retrieveStripeCustomerBillingProfile(input.customerId);
}

export async function listStripeSubscriptionsForCustomer(
  customerId: string,
): Promise<StripeSubscriptionSnapshot[]> {
  if (!env.stripeSecretKey) throw new Error("Stripe subscription listing is not configured. Set STRIPE_SECRET_KEY.");
  const params = new URLSearchParams({ customer: customerId, status: "all", limit: "100" });
  const response = await fetch(`${STRIPE_API_BASE}/subscriptions?${params}`, {
    headers: { Authorization: `Bearer ${env.stripeSecretKey}` },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "object" && body.error
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe subscription listing failed with status ${response.status}`);
  }
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    .map(stripeSubscriptionSnapshot);
}

export async function createStripeTrialSubscription(input: {
  accountId: string;
  accountSlug: string;
  commercialOffer: string;
  customerId: string;
  defaultPaymentMethodId: string;
  trialDays: number;
  idempotencyKey: string;
}): Promise<StripeSubscriptionSnapshot> {
  assertStripeCheckoutConfigured();
  const params = new URLSearchParams({
    customer: input.customerId,
    "items[0][price]": env.stripePriceId!,
    "items[0][quantity]": "1",
    default_payment_method: input.defaultPaymentMethodId,
    trial_period_days: String(input.trialDays),
    "trial_settings[end_behavior][missing_payment_method]": "cancel",
    payment_behavior: "default_incomplete",
    "payment_settings[save_default_payment_method]": "on_subscription",
    "metadata[account_id]": input.accountId,
    "metadata[account_slug]": input.accountSlug,
    "metadata[commercial_offer]": input.commercialOffer,
    "metadata[activation_contract]": "delayed-text-back-v1",
  });
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
      ? stringValue((body.error as Record<string, unknown>).message)
      : null;
    throw new Error(message ?? `Stripe trial subscription creation failed with status ${response.status}`);
  }
  return stripeSubscriptionSnapshot(body);
}

export function stripeDashboardPaymentUrl(paymentIntentId: string) {
  if (!/^pi_[a-zA-Z0-9_]+$/.test(paymentIntentId)) {
    return null;
  }
  const modePath = expectedStripeLivemode() === false ? "/test" : "";
  return `https://dashboard.stripe.com${modePath}/payments/${encodeURIComponent(paymentIntentId)}`;
}

export function setupFeeStateFromPayment(
  payment: StripePaymentIntentSnapshot,
  expectedSetupFeeCents = RELAY_SETUP_FEE_CENTS,
): Pick<
  AccountBillingRecord,
  "setupFeeStatus" | "setupFeeRefundedCents" | "setupFeeDisputeStatus"
> {
  const matchesSetupTerms =
    payment.currency === "usd" &&
    payment.amount === expectedSetupFeeCents &&
    payment.amountReceived === expectedSetupFeeCents;
  const fullyRefunded = payment.amountRefunded >= Math.max(payment.amountReceived, payment.amount);
  const disputeStatus = payment.disputeStatus ?? null;
  const unresolvedDispute = disputeStatus !== null &&
    disputeStatus !== "won" &&
    disputeStatus !== "lost";
  return {
    setupFeeStatus: disputeStatus === "lost"
      ? "charged_back"
      : unresolvedDispute || (payment.disputed && disputeStatus !== "won")
        ? "disputed"
        : matchesSetupTerms && fullyRefunded
          ? "refunded"
          : matchesSetupTerms && payment.amountRefunded > 0
            ? "partially_refunded"
            : matchesSetupTerms && payment.status === "succeeded"
              ? "paid"
              : "due",
    setupFeeRefundedCents: payment.amountRefunded,
    setupFeeDisputeStatus: disputeStatus,
  };
}

export function reconcileSetupFeeStateFromPayment(
  payment: StripePaymentIntentSnapshot,
  current: Pick<AccountBillingRecord, "setupFeeStatus" | "setupFeeDisputeStatus"> &
    Partial<Pick<AccountBillingRecord, "setupFeeCents">>,
): Pick<AccountBillingRecord, "setupFeeStatus" | "setupFeeRefundedCents" | "setupFeeDisputeStatus"> {
  const state = setupFeeStateFromPayment(payment, RELAY_SETUP_FEE_CENTS);
  const hasExplicitResolution = payment.disputeStatus === "won" || payment.disputeStatus === "lost";

  if (!hasExplicitResolution && current.setupFeeStatus === "charged_back") {
    return {
      ...state,
      setupFeeStatus: "charged_back",
      setupFeeDisputeStatus: payment.disputeStatus ?? current.setupFeeDisputeStatus,
    };
  }

  if (
    !hasExplicitResolution &&
    current.setupFeeStatus === "disputed" &&
    !payment.disputeStatus
  ) {
    return {
      ...state,
      setupFeeStatus: "disputed",
      setupFeeDisputeStatus: current.setupFeeDisputeStatus,
    };
  }

  return state;
}

export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
) {
  const parts = (signatureHeader ?? "")
    .split(",")
    .map((part) => part.trim().split("="))
    .filter((part): part is [string, string] => part.length === 2);
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts
    .filter(([key, value]) => key === "v1" && /^[a-fA-F0-9]{64}$/.test(value))
    .map(([, value]) => value);

  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    return false;
  }

  const ageSeconds = Math.abs(nowMs / 1000 - timestamp);
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return signatures.some((signature) => {
    const actualBuffer = Buffer.from(signature, "hex");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  });
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
      ? eventType === "customer.deleted" || eventType === "customer.updated"
        ? stringValue(object.id)
        : stringValue(object.customer)
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
    trialStartsAt: unixSecondsToIso(subscription.trial_start),
    trialEndsAt: unixSecondsToIso(subscription.trial_end),
    currentPeriodEnd: subscriptionPeriodEnd(subscription),
    cancelAtPeriodEnd: subscriptionCancelAtPeriodEnd(subscription),
    metadataAccountId: metadataAccountId(subscription),
    livemode: subscription.livemode === true,
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
  options: { nowIso?: string } = {},
): StripeBillingUpdate {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const billingStatus = mapStripeSubscriptionStatus(subscription.status);

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
    activatedAt: subscription.trialStartsAt,
    billingAttentionSince: billingStatus === "past_due" ? nowIso : null,
  };
}

export function billingDatesFromPaidInvoice(
  invoice: Record<string, unknown>,
): Pick<StripeBillingUpdate, "firstPaidAt" | "guaranteeEndsAt"> | null {
  if (invoice.paid !== true && invoice.status !== "paid") return null;
  if ((numberValue(invoice.amount_paid) ?? 0) <= 0) return null;

  const transitions = invoice.status_transitions && typeof invoice.status_transitions === "object"
    ? invoice.status_transitions as Record<string, unknown>
    : null;
  const firstPaidAt = transitions ? unixSecondsToIso(transitions.paid_at) : null;
  if (!firstPaidAt) return null;

  return {
    firstPaidAt,
    guaranteeEndsAt: new Date(Date.parse(firstPaidAt) + 30 * DAY_MS).toISOString(),
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

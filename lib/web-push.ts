import "server-only";

import webPush from "web-push";
import { env } from "@/lib/env";
import {
  listActiveOwnerPushSubscriptions,
  markOwnerPushSubscriptionFailed,
  markOwnerPushSubscriptionSucceeded,
  type AccountRuntimeConfig,
  type OwnerPushEvent,
} from "@/lib/supabase";

const PUSH_TIMEOUT_MS = 10_000;

export function webPushIsConfigured() {
  return Boolean(env.webPushPublicKey && env.webPushPrivateKey && env.webPushContact);
}

function phoneLast4(value: string | null | undefined) {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : "unknown";
}

function pushStatusCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }

  return null;
}

async function safelyRecordDeliveryResult(input: {
  accountId: string;
  subscriptionId: string;
  failureCount: number;
  success: boolean;
  disable?: boolean;
}) {
  try {
    if (input.success) {
      await markOwnerPushSubscriptionSucceeded({
        accountId: input.accountId,
        id: input.subscriptionId,
      });
      return;
    }

    await markOwnerPushSubscriptionFailed({
      accountId: input.accountId,
      id: input.subscriptionId,
      failureCount: input.failureCount,
      disable: input.disable === true,
    });
  } catch (error) {
    console.error("Could not update owner push subscription evidence", {
      accountId: input.accountId,
      subscriptionId: input.subscriptionId,
      error: error instanceof Error ? error.message : error,
    });
  }
}

export async function notifyOwnerByWebPush(input: {
  account: Pick<AccountRuntimeConfig, "accountId" | "businessName">;
  event: OwnerPushEvent;
  leadId: string;
  callerPhone?: string | null;
}) {
  const accountId = input.account.accountId;

  if (!accountId || !webPushIsConfigured()) {
    return { attempted: 0, delivered: 0, disabled: 0 };
  }

  let subscriptions;
  try {
    subscriptions = await listActiveOwnerPushSubscriptions(accountId, input.event);
  } catch (error) {
    console.error("Could not load owner push subscriptions", {
      accountId,
      event: input.event,
      error: error instanceof Error ? error.message : error,
    });
    return { attempted: 0, delivered: 0, disabled: 0 };
  }

  const last4 = phoneLast4(input.callerPhone);
  const payload = JSON.stringify({
    title: input.event === "missed_call"
      ? `Missed call for ${input.account.businessName}`
      : `Voicemail ready for ${input.account.businessName}`,
    body: input.event === "missed_call"
      ? `Caller ending in ${last4}. Open Relay to follow up.`
      : `The verified voicemail is ready for caller ending in ${last4}.`,
    url: `/leads/${encodeURIComponent(input.leadId)}`,
    tag: `relay:${input.event}:${input.leadId}`,
  });

  let delivered = 0;
  let disabled = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      }, payload, {
        TTL: input.event === "missed_call" ? 5 * 60 : 30 * 60,
        urgency: input.event === "missed_call" ? "high" : "normal",
        timeout: PUSH_TIMEOUT_MS,
        vapidDetails: {
          subject: env.webPushContact,
          publicKey: env.webPushPublicKey!,
          privateKey: env.webPushPrivateKey!,
        },
      });
      delivered += 1;
      await safelyRecordDeliveryResult({
        accountId,
        subscriptionId: subscription.id,
        failureCount: 0,
        success: true,
      });
    } catch (error) {
      const statusCode = pushStatusCode(error);
      const isGone = statusCode === 404 || statusCode === 410;
      if (isGone) disabled += 1;
      console.error("Owner Web Push delivery failed", {
        accountId,
        event: input.event,
        subscriptionId: subscription.id,
        statusCode,
        error: error instanceof Error ? error.message : error,
      });
      await safelyRecordDeliveryResult({
        accountId,
        subscriptionId: subscription.id,
        failureCount: subscription.failureCount + 1,
        success: false,
        disable: isGone,
      });
    }
  }));

  return { attempted: subscriptions.length, delivered, disabled };
}

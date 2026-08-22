import { requireAccountUserJson } from "@/lib/auth";
import {
  disableOwnerPushSubscription,
  upsertOwnerPushSubscription,
} from "@/lib/supabase";

export const runtime = "nodejs";

type SubscriptionInput = {
  endpoint?: unknown;
  keys?: {
    p256dh?: unknown;
    auth?: unknown;
  };
};

function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validKey(value: unknown, minLength: number): value is string {
  return typeof value === "string"
    && value.length >= minLength
    && value.length <= 255
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = Response.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request) {
  const auth = await requireAccountUserJson();
  if (auth.response) return auth.response;

  let body: {
    subscription?: SubscriptionInput;
    missedCallEnabled?: unknown;
    voicemailReadyEnabled?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
  }

  const subscription = body.subscription;
  if (
    !subscription
    || !validEndpoint(subscription.endpoint)
    || !validKey(subscription.keys?.p256dh, 40)
    || !validKey(subscription.keys?.auth, 8)
  ) {
    return noStoreJson({ error: "Invalid push subscription" }, { status: 400 });
  }

  try {
    await upsertOwnerPushSubscription({
      accountId: auth.session.accountId,
      userId: auth.session.userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
      missedCallEnabled: body.missedCallEnabled !== false,
      voicemailReadyEnabled: body.voicemailReadyEnabled !== false,
    });
  } catch (error) {
    console.error("Could not save owner push subscription", {
      accountId: auth.session.accountId,
      userId: auth.session.userId,
      error: error instanceof Error ? error.message : error,
    });
    return noStoreJson({ error: "Could not enable browser notifications" }, { status: 503 });
  }

  return noStoreJson({ enabled: true });
}

export async function DELETE(request: Request) {
  const auth = await requireAccountUserJson();
  if (auth.response) return auth.response;

  let body: { endpoint?: unknown };
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!validEndpoint(body.endpoint)) {
    return noStoreJson({ error: "Invalid push endpoint" }, { status: 400 });
  }

  try {
    await disableOwnerPushSubscription({
      accountId: auth.session.accountId,
      userId: auth.session.userId,
      endpoint: body.endpoint,
    });
  } catch (error) {
    console.error("Could not disable owner push subscription", {
      accountId: auth.session.accountId,
      userId: auth.session.userId,
      error: error instanceof Error ? error.message : error,
    });
    return noStoreJson({ error: "Could not disable browser notifications" }, { status: 503 });
  }

  return noStoreJson({ enabled: false });
}

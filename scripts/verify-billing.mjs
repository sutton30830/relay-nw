import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const EXPECTED_PRICE_CENTS = 9900;
const EXPECTED_CURRENCY = "usd";

export const requiredStripeWebhookEvents = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.paid",
];

function parseDotenvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;

  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [match[1], value];
}

async function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;

    const contents = await readFile(file, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const parsed = parseDotenvLine(line);
      if (!parsed) continue;

      const [key, value] = parsed;
      process.env[key] ??= value;
    }
  }
}

function addCheck(checks, ok, label, detail, level = ok ? "pass" : "fail") {
  checks.push({ ok, level, label, detail });
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeBaseUrl(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function keyMode(secretKey) {
  if (secretKey?.startsWith("sk_live_")) return "live";
  if (secretKey?.startsWith("sk_test_")) return "test";
  return "unknown";
}

export function redactStripeSecret(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 12) return "••••";
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

async function stripeGet(path, secretKey, fetchImpl) {
  const response = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof body?.error === "object" && body.error
        ? stringValue(body.error.message)
        : null;
    throw new Error(message ?? `Stripe API failed with status ${response.status}`);
  }

  return body;
}

function verifyEnv(inputEnv, checks) {
  const required = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "APP_BASE_URL"];
  const missing = required.filter((name) => !stringValue(inputEnv[name]));

  if (missing.length) {
    addCheck(checks, false, "Stripe environment", `Missing ${missing.join(", ")}.`);
    return null;
  }

  const secretKey = inputEnv.STRIPE_SECRET_KEY;
  const mode = keyMode(secretKey);
  const appBaseUrl = normalizeBaseUrl(inputEnv.APP_BASE_URL);

  if (mode === "unknown") {
    addCheck(checks, false, "Stripe secret key", "STRIPE_SECRET_KEY must start with sk_test_ or sk_live_.");
  } else {
    addCheck(checks, true, "Stripe secret key", `Using ${mode} key ${redactStripeSecret(secretKey)}.`);
  }

  if (mode === "live" && (!appBaseUrl.startsWith("https://") || appBaseUrl.includes("localhost"))) {
    addCheck(
      checks,
      false,
      "Production app URL",
      "Live Stripe keys require an https production APP_BASE_URL, not localhost.",
    );
  } else if (!appBaseUrl) {
    addCheck(checks, false, "App base URL", "APP_BASE_URL is empty.");
  } else {
    addCheck(checks, true, "App base URL", appBaseUrl);
  }

  return {
    secretKey,
    mode,
    priceId: inputEnv.STRIPE_PRICE_ID,
    appBaseUrl,
    expectedWebhookUrl: `${appBaseUrl}/api/stripe/webhook`,
  };
}

function verifyPrice(price, mode, checks) {
  const priceMode = price?.livemode === true ? "live" : "test";
  const recurring = price?.recurring && typeof price.recurring === "object" ? price.recurring : {};
  const interval = recurring.interval;
  const intervalCount = recurring.interval_count;

  addCheck(
    checks,
    price?.active === true,
    "Stripe price active",
    price?.active === true ? `Price ${price.id} is active.` : `Price ${price?.id ?? "unknown"} is not active.`,
  );

  addCheck(
    checks,
    price?.type === "recurring" && interval === "month" && intervalCount === 1,
    "Stripe price interval",
    price?.type === "recurring" && interval === "month" && intervalCount === 1
      ? "Price is a monthly recurring subscription."
      : `Expected monthly recurring price; got type=${price?.type ?? "unknown"} interval=${interval ?? "none"} interval_count=${intervalCount ?? "none"}.`,
  );

  addCheck(
    checks,
    price?.currency === EXPECTED_CURRENCY && price?.unit_amount === EXPECTED_PRICE_CENTS,
    "Stripe price amount",
    price?.currency === EXPECTED_CURRENCY && price?.unit_amount === EXPECTED_PRICE_CENTS
      ? "$99/month price matches owner-facing copy."
      : `Expected ${EXPECTED_CURRENCY} ${EXPECTED_PRICE_CENTS}; got ${price?.currency ?? "unknown"} ${price?.unit_amount ?? "unknown"}.`,
  );

  addCheck(
    checks,
    mode === "unknown" || priceMode === mode,
    "Stripe price mode",
    priceMode === mode ? `Price is in ${priceMode} mode.` : `Secret key is ${mode}, but price is ${priceMode}.`,
  );
}

function verifyPortal(configurations, checks) {
  const activeConfigs = Array.isArray(configurations?.data)
    ? configurations.data.filter((config) => config?.active === true)
    : [];

  addCheck(
    checks,
    activeConfigs.length > 0,
    "Customer Portal configuration",
    activeConfigs.length > 0
      ? `${activeConfigs.length} active Stripe Customer Portal configuration(s) found.`
      : "No active Stripe Customer Portal configuration found. Configure Portal before launch.",
  );
}

function endpointHasRequiredEvents(endpoint) {
  const enabledEvents = Array.isArray(endpoint?.enabled_events) ? endpoint.enabled_events : [];
  if (enabledEvents.includes("*")) return [];
  return requiredStripeWebhookEvents.filter((event) => !enabledEvents.includes(event));
}

function verifyWebhookEndpoints(webhookEndpoints, expectedWebhookUrl, checks) {
  const endpoints = Array.isArray(webhookEndpoints?.data) ? webhookEndpoints.data : [];
  const matching = endpoints.filter((endpoint) => endpoint?.url === expectedWebhookUrl);
  const enabled = matching.filter((endpoint) => endpoint?.status === "enabled");

  if (!matching.length) {
    addCheck(
      checks,
      false,
      "Stripe webhook endpoint",
      `No Stripe webhook endpoint found for ${expectedWebhookUrl}.`,
    );
    return;
  }

  addCheck(
    checks,
    enabled.length > 0,
    "Stripe webhook endpoint",
    enabled.length > 0
      ? `Enabled webhook endpoint found for ${expectedWebhookUrl}.`
      : `Webhook endpoint exists for ${expectedWebhookUrl}, but it is not enabled.`,
  );

  const endpoint = enabled[0] ?? matching[0];
  const missingEvents = endpointHasRequiredEvents(endpoint);

  addCheck(
    checks,
    missingEvents.length === 0,
    "Stripe webhook events",
    missingEvents.length === 0
      ? "Webhook endpoint listens for every Relay billing event."
      : `Webhook endpoint is missing: ${missingEvents.join(", ")}.`,
  );
}

export async function verifyBillingConfig({ env: inputEnv = process.env, fetchImpl = fetch } = {}) {
  const checks = [];
  const config = verifyEnv(inputEnv, checks);

  if (!config) {
    return { ok: false, checks };
  }

  try {
    const price = await stripeGet(`/prices/${encodeURIComponent(config.priceId)}`, config.secretKey, fetchImpl);
    verifyPrice(price, config.mode, checks);
  } catch (error) {
    addCheck(checks, false, "Stripe price lookup", error instanceof Error ? error.message : String(error));
  }

  try {
    const portalConfigurations = await stripeGet(
      "/billing_portal/configurations?active=true&limit=10",
      config.secretKey,
      fetchImpl,
    );
    verifyPortal(portalConfigurations, checks);
  } catch (error) {
    addCheck(checks, false, "Customer Portal lookup", error instanceof Error ? error.message : String(error));
  }

  try {
    const webhookEndpoints = await stripeGet("/webhook_endpoints?limit=100", config.secretKey, fetchImpl);
    verifyWebhookEndpoints(webhookEndpoints, config.expectedWebhookUrl, checks);
  } catch (error) {
    addCheck(checks, false, "Stripe webhook lookup", error instanceof Error ? error.message : String(error));
  }

  return {
    ok: checks.every((check) => check.ok || check.level === "warn"),
    checks,
  };
}

function icon(check) {
  if (check.ok) return "✓";
  if (check.level === "warn") return "!";
  return "✕";
}

async function main() {
  await loadLocalEnv();

  const result = await verifyBillingConfig();

  console.log("Relay NW billing verification");
  console.log("");

  for (const check of result.checks) {
    console.log(`${icon(check)} ${check.label}`);
    console.log(`  ${check.detail}`);
  }

  console.log("");
  if (result.ok) {
    console.log("Billing launch checks passed.");
    return;
  }

  console.error("Billing launch checks failed. Fix the failed items before charging owners.");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

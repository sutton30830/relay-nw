import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { verifyBillingConfig } from "./verify-billing.mjs";
import { runBillingControlsRehearsal } from "./verify-billing-controls.mjs";

const READY_A2P_STATUSES = new Set(["approved"]);
const ACTIVE_BILLING_STATUSES = new Set(["active", "trialing", "comped"]);
const CUSTOMER_DELAY_STATUSES = new Set(["requirements_needed", "waiting_on_customer", "paused_incomplete", "closed_incomplete"]);
const CARRIER_DELAY_STATUSES = new Set(["carrier_review", "carrier_attention"]);
const BLOCKING_STRIPE_STATUS_FOR_ACTIVE = new Set(["canceled", "unpaid", "past_due", "incomplete_expired"]);

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

function optionalEnv(name, env = process.env) {
  return env[name] || null;
}

function requiredEnv(name, env = process.env) {
  const value = optionalEnv(name, env);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizePhoneNumber(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(value ?? "").trim().startsWith("+")) return String(value).trim();
  return String(value ?? "").trim();
}

function isPlaceholderPhone(value) {
  const normalized = normalizePhoneNumber(value);
  const digits = normalized.replace(/\D/g, "");

  return (
    !/^\+\d{10,15}$/.test(normalized) ||
    digits === "15551234567" ||
    digits === "15557654321" ||
    digits.endsWith("5551234") ||
    /^0+$/.test(digits)
  );
}

function addCheck(checks, ok, label, detail, level = ok ? "pass" : "fail") {
  checks.push({ ok, label, detail, level });
}

function statusLine(check) {
  const marker = check.ok ? "PASS" : check.level === "warn" ? "WARN" : "FAIL";
  const detail = check.detail ? ` - ${check.detail}` : "";
  return `[${marker}] ${check.label}${detail}`;
}

export function parseLaunchArgs(argv) {
  let slug = "";
  let billingControlsSlug = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--billing-controls") {
      billingControlsSlug = argv[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }

    if (!arg?.startsWith("--") && !slug) {
      slug = arg.trim();
    }
  }

  return {
    slug,
    billingControlsSlug,
  };
}

function firstRow(rows) {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function deriveCallCaptureReady({ settings, latestLead, lastPassedForwarding }) {
  if (!settings) return { ready: false, detail: "Missing account_settings." };
  if (settings.call_mode === "direct") {
    return latestLead
      ? { ready: true, detail: `Direct mode has a recovered lead from ${latestLead.created_at}.` }
      : { ready: false, detail: "Direct mode needs one real missed-call test in the inbox." };
  }

  return lastPassedForwarding
    ? { ready: true, detail: `Forwarding passed at ${lastPassedForwarding.completed_at}.` }
    : { ready: false, detail: "Forwarding mode needs a passed forwarding health check." };
}

function deriveCheckoutAllowed({ account, activationReady }) {
  const billingStatus = account?.billing_status ?? "not_started";
  const stripeStatus = account?.stripe_subscription_status ?? null;

  if (!activationReady) return { ok: false, detail: "Checkout is blocked until call capture and A2P/SMS registration are ready." };
  if (billingStatus === "active" || billingStatus === "trialing" || stripeStatus === "active" || stripeStatus === "trialing") {
    return { ok: false, detail: "Checkout should be blocked because billing is already active/trialing." };
  }
  if (billingStatus === "past_due" || stripeStatus === "past_due" || stripeStatus === "unpaid") {
    return { ok: false, detail: "Checkout should be blocked; send the owner to the Customer Portal to update payment." };
  }
  if (billingStatus === "not_started") return { ok: true, detail: "Checkout may start once the owner is handed off." };
  if (billingStatus === "canceled" && (!stripeStatus || stripeStatus === "canceled" || stripeStatus === "incomplete_expired")) {
    return { ok: true, detail: "A fully canceled account may restart through Checkout." };
  }

  return { ok: false, detail: `Checkout should be blocked for billing_status=${billingStatus}, stripe_subscription_status=${stripeStatus ?? "none"}.` };
}

function deriveEffectiveOnboardingStatus(account, activationReady) {
  const status = account?.onboarding_status ?? "requirements_needed";
  const billingStatus = account?.billing_status ?? "not_started";

  if (
    status === "activated" ||
    account?.activated_at ||
    account?.first_paid_at ||
    billingStatus === "active" ||
    billingStatus === "trialing" ||
    billingStatus === "comped"
  ) {
    return "activated";
  }

  if (status === "paused_incomplete" || status === "closed_incomplete") return status;
  if (activationReady) return "ready_to_activate";
  return status;
}

function onboardingBlocker(account, activationReady) {
  const status = deriveEffectiveOnboardingStatus(account, activationReady);
  if (CUSTOMER_DELAY_STATUSES.has(status)) return "customer_delay";
  if (CARRIER_DELAY_STATUSES.has(status)) return "carrier_delay";
  if (status === "ready_for_live_test") return "setup";
  if (status === "ready_to_activate" || status === "activated") return "none";
  return "setup";
}

export function analyzeLaunchCertification(input) {
  const {
    account,
    settings,
    primaryNumber,
    adminUsers = [],
    latestLead,
    lastPassedForwarding,
    billingConfigResult,
  } = input;
  const checks = [];

  addCheck(checks, Boolean(account), "account exists", account ? `${account.slug} (${account.status})` : "No account row found.");
  if (!account) return { ok: false, checks };

  addCheck(checks, account.status === "active", "account active", account.status === "active" ? "Account row is active." : `Current status is ${account.status}.`);
  addCheck(
    checks,
    true,
    "Stripe identifiers",
    `customer=${account.stripe_customer_id ?? "none"}, subscription=${account.stripe_subscription_id ?? "none"}, price=${account.stripe_price_id ?? "none"}.`,
  );
  addCheck(checks, Boolean(settings), "account_settings exists", settings ? settings.business_name : "Missing account_settings row.");
  addCheck(
    checks,
    Boolean(settings?.owner_email),
    "owner email",
    settings?.owner_email ?? "Missing owner_email; owner billing/setup messages cannot be delivered.",
  );
  addCheck(
    checks,
    Boolean(settings?.owner_phone_number) && !isPlaceholderPhone(settings.owner_phone_number),
    "owner phone",
    settings?.owner_phone_number ? normalizePhoneNumber(settings.owner_phone_number) : "Missing owner phone.",
  );
  addCheck(
    checks,
    Boolean(primaryNumber?.phone_number) && !isPlaceholderPhone(primaryNumber.phone_number),
    "Relay phone number",
    primaryNumber?.phone_number ? normalizePhoneNumber(primaryNumber.phone_number) : "Missing primary Relay phone number.",
  );
  addCheck(
    checks,
    adminUsers.some((user) => user.role === "owner" && user.user_id),
    "owner auth linked",
    adminUsers.length
      ? adminUsers.map((user) => `${user.role}:${user.email ?? "missing-email"}:${user.user_id ? "linked" : "unlinked"}`).join(", ")
      : "No owner/admin membership rows.",
  );

  const callCapture = deriveCallCaptureReady({ settings, latestLead, lastPassedForwarding });
  const smsRegistrationReady = READY_A2P_STATUSES.has(settings?.a2p_registration_status ?? "not_started");
  const activationReady = callCapture.ready && smsRegistrationReady;
  const effectiveOnboardingStatus = deriveEffectiveOnboardingStatus(account, activationReady);
  const checkoutAllowed = deriveCheckoutAllowed({ account, activationReady });
  const blocker = onboardingBlocker(account, activationReady);

  addCheck(
    checks,
    true,
    "onboarding lifecycle",
    `onboarding_status=${account.onboarding_status ?? "requirements_needed"}, effective=${effectiveOnboardingStatus}, requirements_due_at=${account.requirements_due_at ?? "none"}, activated_at=${account.activated_at ?? "none"}, first_paid_at=${account.first_paid_at ?? "none"}, guarantee_ends_at=${account.guarantee_ends_at ?? "none"}.`,
  );

  addCheck(checks, callCapture.ready, "call capture readiness", callCapture.detail);
  addCheck(
    checks,
    smsRegistrationReady,
    "A2P/SMS registration readiness",
    smsRegistrationReady
      ? "Carrier registration is approved."
      : `a2p_registration_status=${settings?.a2p_registration_status ?? "missing"}.`,
  );
  addCheck(
    checks,
    settings?.sms_enabled === true,
    "automatic SMS mode",
    settings?.sms_enabled
      ? "Auto-texting is on."
      : "Auto-texting is paused by owner choice; this is not a setup failure, but launch handoff should mention callers are not receiving immediate replies.",
    settings?.sms_enabled ? "pass" : "warn",
  );
  addCheck(
    checks,
    activationReady,
    "activation readiness",
    activationReady ? "Call capture and carrier texting approval are ready." : "Do not charge or hand off as activated yet.",
  );
  addCheck(
    checks,
    blocker === "none",
    "onboarding blocker",
    blocker === "none"
      ? `effective_onboarding_status=${effectiveOnboardingStatus}.`
      : blocker === "customer_delay"
        ? `Blocked by customer delay: effective_onboarding_status=${effectiveOnboardingStatus}.`
        : blocker === "carrier_delay"
          ? `Blocked by carrier/A2P delay: effective_onboarding_status=${effectiveOnboardingStatus}.`
          : `Blocked by setup: effective_onboarding_status=${effectiveOnboardingStatus}.`,
    blocker === "none" ? "pass" : "warn",
  );
  addCheck(
    checks,
    ACTIVE_BILLING_STATUSES.has(account.billing_status ?? "not_started"),
    "billing status",
    `billing_status=${account.billing_status ?? "not_started"}, stripe_subscription_status=${account.stripe_subscription_status ?? "none"}.`,
    ACTIVE_BILLING_STATUSES.has(account.billing_status ?? "not_started") ? "pass" : "warn",
  );

  const dangerousStripeDisagreement =
    ACTIVE_BILLING_STATUSES.has(account.billing_status ?? "not_started") &&
    account.billing_status !== "comped" &&
    BLOCKING_STRIPE_STATUS_FOR_ACTIVE.has(account.stripe_subscription_status ?? "");
  addCheck(
    checks,
    !dangerousStripeDisagreement,
    "Stripe/account billing agreement",
    dangerousStripeDisagreement
      ? `Relay says ${account.billing_status}, but Stripe subscription status is ${account.stripe_subscription_status}.`
      : "No dangerous billing status disagreement detected.",
  );
  addCheck(
    checks,
    checkoutAllowed.ok,
    "Checkout allowed",
    checkoutAllowed.detail,
    checkoutAllowed.ok ? "pass" : "warn",
  );
  addCheck(
    checks,
    Boolean(account.stripe_customer_id),
    "Customer Portal available",
    account.stripe_customer_id
      ? `Portal can use customer ${account.stripe_customer_id}.`
      : "No stripe_customer_id yet; Portal is unavailable until Checkout creates/reuses a customer.",
    account.stripe_customer_id ? "pass" : "warn",
  );

  if (billingConfigResult) {
    for (const check of billingConfigResult.checks) {
      addCheck(checks, check.ok || check.level === "warn", `Stripe config: ${check.label}`, check.detail, check.ok ? "pass" : check.level);
    }
    addCheck(
      checks,
      billingConfigResult.ok,
      "Stripe config launch-safe",
      billingConfigResult.ok ? "Stripe price, portal, and webhook config passed." : "Stripe config has blocking launch issues.",
    );
  } else {
    addCheck(checks, false, "Stripe config launch-safe", "Stripe config was not checked.");
  }

  const failures = checks.filter((check) => !check.ok && check.level !== "warn");
  return { ok: failures.length === 0, checks, blocker, activationReady, checkoutAllowed };
}

async function maybeSingle(query, label) {
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function selectRows(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

async function loadAccountFacts(supabase, slug) {
  const account = await maybeSingle(
    supabase
      .from("accounts")
      .select("id, slug, name, status, billing_status, onboarding_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_subscription_status, trial_ends_at, current_period_end, cancel_at_period_end, requirements_due_at, activated_at, first_paid_at, guarantee_ends_at, billing_attention_since")
      .eq("slug", slug),
    "account lookup",
  );

  if (!account) {
    return { account: null };
  }

  const [settings, phoneNumbers, adminUsers, leads, lastPassedForwardingRows] = await Promise.all([
    maybeSingle(
      supabase
        .from("account_settings")
        .select("account_id, business_name, owner_email, owner_phone_number, call_mode, sms_enabled, a2p_registration_status")
        .eq("account_id", account.id),
      "account_settings lookup",
    ),
    selectRows(
      supabase
        .from("account_phone_numbers")
        .select("phone_number, is_primary, twilio_sid")
        .eq("account_id", account.id)
        .order("is_primary", { ascending: false }),
      "account_phone_numbers lookup",
    ),
    selectRows(
      supabase
        .from("account_users")
        .select("email, role, user_id")
        .eq("account_id", account.id)
        .in("role", ["owner", "admin"]),
      "account_users lookup",
    ),
    selectRows(
      supabase
        .from("leads")
        .select("id, created_at, phone")
        .eq("account_id", account.id)
        .order("created_at", { ascending: false })
        .limit(1),
      "latest lead lookup",
    ),
    selectRows(
      supabase
        .from("forwarding_health_checks")
        .select("id, completed_at")
        .eq("account_id", account.id)
        .eq("status", "passed")
        .order("completed_at", { ascending: false })
        .limit(1),
      "forwarding health lookup",
    ),
  ]);

  return {
    account,
    settings,
    primaryNumber: phoneNumbers.find((row) => row.is_primary) ?? null,
    adminUsers,
    latestLead: firstRow(leads),
    lastPassedForwarding: firstRow(lastPassedForwardingRows),
  };
}

export async function verifyLaunchCertification({
  slug,
  env = process.env,
  fetchImpl = fetch,
  supabaseClient = null,
  billingConfigResult = null,
} = {}) {
  if (!slug) throw new Error("verifyLaunchCertification requires an account slug");

  const supabase = supabaseClient ?? createClient(
    optionalEnv("SUPABASE_URL", env) ?? requiredEnv("NEXT_PUBLIC_SUPABASE_URL", env),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY", env),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  const facts = await loadAccountFacts(supabase, slug);
  const stripeResult = billingConfigResult ?? await verifyBillingConfig({ env, fetchImpl });
  return analyzeLaunchCertification({ ...facts, billingConfigResult: stripeResult });
}

async function main() {
  await loadLocalEnv();

  const { slug, billingControlsSlug } = parseLaunchArgs(process.argv.slice(2));
  if (!slug) {
    console.error("Usage: npm run verify:launch -- <slug> [--billing-controls <scratch-slug>]");
    process.exit(1);
  }

  const result = await verifyLaunchCertification({ slug });

  console.log(`Relay NW launch certification: ${slug}`);
  console.log("");
  for (const check of result.checks) {
    console.log(statusLine(check));
  }

  if (billingControlsSlug) {
    console.log("");
    console.log(`Billing-control scratch rehearsal: ${billingControlsSlug}`);
    const billingControls = await runBillingControlsRehearsal({ slug: billingControlsSlug });
    for (const check of billingControls.checks) {
      console.log(statusLine(check));
    }
    addCheck(
      result.checks,
      billingControls.ok,
      "Billing-control scratch rehearsal",
      billingControls.ok
        ? `Scratch billing controls passed for ${billingControlsSlug}.`
        : `Scratch billing controls failed for ${billingControlsSlug}.`,
    );
    if (!billingControls.ok) {
      result.ok = false;
    }
  }
  console.log("");

  if (!result.ok) {
    const failures = result.checks.filter((check) => !check.ok && check.level !== "warn");
    console.log(`Result: FAIL (${failures.length} blocking issue${failures.length === 1 ? "" : "s"})`);
    process.exitCode = 1;
    return;
  }

  const warnings = result.checks.filter((check) => !check.ok && check.level === "warn");
  if (warnings.length > 0) {
    console.log(`Result: PASS with ${warnings.length} launch warning${warnings.length === 1 ? "" : "s"}`);
    return;
  }

  console.log("Result: PASS");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

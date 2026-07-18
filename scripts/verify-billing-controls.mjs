import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const BILLING_COLUMNS = [
  "billing_status",
  "trial_ends_at",
  "cancel_at_period_end",
  "billing_attention_since",
  "stripe_customer_id",
  "stripe_subscription_id",
  "stripe_subscription_status",
];

const LIVE_STRIPE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

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

function addCheck(checks, ok, label, detail, level = ok ? "pass" : "fail") {
  checks.push({ ok, label, detail, level });
}

function statusLine(check) {
  const marker = check.ok ? "PASS" : check.level === "warn" ? "WARN" : "FAIL";
  const detail = check.detail ? ` - ${check.detail}` : "";
  return `[${marker}] ${check.label}${detail}`;
}

export function isScratchBillingSlug(slug) {
  return /(^|[-_])(scratch|sandbox|test)([-_]|$)/i.test(String(slug ?? ""));
}

export function canRehearseBillingControls(account) {
  if (!account) {
    return { ok: false, reason: "missing_account" };
  }

  if (!isScratchBillingSlug(account.slug)) {
    return { ok: false, reason: "not_scratch" };
  }

  if (account.stripe_subscription_id || LIVE_STRIPE_STATUSES.has(account.stripe_subscription_status ?? "")) {
    return { ok: false, reason: "live_stripe_subscription" };
  }

  return { ok: true };
}

export function snapshotBillingRecord(account) {
  const snapshot = {};
  for (const column of BILLING_COLUMNS) {
    snapshot[column] = account[column] ?? null;
  }
  return snapshot;
}

function futureIso(now, days) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function pastIso(now) {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

export function billingControlRehearsalSteps(now = new Date()) {
  return [
    {
      key: "comp",
      label: "Comp account",
      expectedStatus: "comped",
      update: {
        billing_status: "comped",
        trial_ends_at: null,
        cancel_at_period_end: false,
        billing_attention_since: null,
      },
      auditAction: "billing.operator.comp",
      auditSummary: "Launch rehearsal comped scratch account.",
    },
    {
      key: "uncomp",
      label: "Uncomp account",
      expectedStatus: "not_started",
      update: {
        billing_status: "not_started",
        trial_ends_at: null,
        cancel_at_period_end: false,
        billing_attention_since: null,
      },
      auditAction: "billing.operator.uncomp",
      auditSummary: "Launch rehearsal removed scratch account comp.",
    },
    {
      key: "grant_trial",
      label: "Grant trial",
      expectedStatus: "trialing",
      update: {
        billing_status: "trialing",
        trial_ends_at: futureIso(now, 3),
        cancel_at_period_end: false,
        billing_attention_since: null,
      },
      auditAction: "billing.operator.grant_trial",
      auditSummary: "Launch rehearsal granted a scratch account trial.",
    },
    {
      key: "expiry_flip",
      label: "Expire app-level trial",
      expectedStatus: "past_due",
      update: {
        billing_status: "past_due",
        trial_ends_at: pastIso(now),
        cancel_at_period_end: false,
        billing_attention_since: now.toISOString(),
      },
      auditAction: "billing.trial.expired",
      auditSummary: "Launch rehearsal expired a scratch account trial. Call capture remains on.",
    },
  ];
}

function createSupabaseStore(env = process.env) {
  const supabase = createClient(
    optionalEnv("SUPABASE_URL", env) ?? requiredEnv("NEXT_PUBLIC_SUPABASE_URL", env),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY", env),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  return {
    async loadAccount(slug) {
      const { data, error } = await supabase
        .from("accounts")
        .select(`id, slug, ${BILLING_COLUMNS.join(", ")}`)
        .eq("slug", slug)
        .maybeSingle();

      if (error) throw new Error(`account lookup: ${error.message}`);
      return data ?? null;
    },
    async updateAccount(accountId, update) {
      const { error } = await supabase
        .from("accounts")
        .update({ ...update, billing_updated_at: new Date().toISOString() })
        .eq("id", accountId);

      if (error) throw new Error(`account update: ${error.message}`);
    },
    async recordAudit(accountId, action, summary) {
      const { error } = await supabase
        .from("account_audit_events")
        .insert({
          account_id: accountId,
          actor_user_id: null,
          actor_email: "system:verify-billing-controls",
          action,
          summary,
        });

      if (error) {
        console.warn("Could not record billing-control rehearsal audit event.", {
          accountId,
          action,
          error: error.message,
        });
      }
    },
  };
}

export async function runBillingControlsRehearsal({
  slug,
  store = createSupabaseStore(),
  now = new Date(),
  restoreOriginal = true,
} = {}) {
  const checks = [];
  if (!slug) {
    addCheck(checks, false, "scratch account slug", "Usage: npm run verify:billing-controls -- <scratch-slug>.");
    return { ok: false, checks };
  }

  const account = await store.loadAccount(slug);
  const guard = canRehearseBillingControls(account);
  addCheck(
    checks,
    guard.ok,
    "scratch billing guard",
    guard.ok
      ? `${slug} is a scratch account with no live Stripe subscription.`
      : guard.reason === "not_scratch"
        ? "Refusing to mutate a non-scratch account. Use a slug containing scratch, sandbox, or test."
        : guard.reason === "live_stripe_subscription"
          ? "Refusing to mutate an account with a Stripe subscription or live subscription status."
          : "No account row found.",
  );

  if (!guard.ok) {
    return { ok: false, checks };
  }

  const snapshot = snapshotBillingRecord(account);
  let restored = false;

  try {
    for (const step of billingControlRehearsalSteps(now)) {
      await store.updateAccount(account.id, step.update);
      await store.recordAudit(account.id, step.auditAction, step.auditSummary);
      const refreshed = await store.loadAccount(slug);
      addCheck(
        checks,
        refreshed?.billing_status === step.expectedStatus,
        step.label,
        refreshed
          ? `billing_status=${refreshed.billing_status}, trial_ends_at=${refreshed.trial_ends_at ?? "none"}`
          : "Account disappeared during rehearsal.",
      );
    }
  } finally {
    if (restoreOriginal) {
      await store.updateAccount(account.id, snapshot);
      restored = true;
    }
  }

  addCheck(
    checks,
    restored || !restoreOriginal,
    "scratch account restored",
    restored ? "Original billing fields restored after rehearsal." : "State intentionally left at the final rehearsal step.",
    restored ? "pass" : "warn",
  );

  const failures = checks.filter((check) => !check.ok && check.level !== "warn");
  return { ok: failures.length === 0, checks };
}

async function main() {
  await loadLocalEnv();

  const slug = process.argv[2]?.trim();
  const keepState = process.argv.includes("--keep-state");
  const result = await runBillingControlsRehearsal({
    slug,
    restoreOriginal: !keepState,
  });

  console.log(`Relay NW billing-control rehearsal: ${slug ?? "(missing)"}`);
  console.log("");
  for (const check of result.checks) {
    console.log(statusLine(check));
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
    console.log(`Result: PASS with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
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

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const READY_A2P_STATUSES = new Set(["approved"]);
const ADMIN_ROLES = new Set(["owner", "admin"]);

function deriveSmsOperatingState(settings) {
  const a2pStatus = settings?.a2p_registration_status ?? "not_started";
  const smsEnabled = Boolean(settings?.sms_enabled);

  if (!READY_A2P_STATUSES.has(a2pStatus)) {
    return {
      key: "calls_ready_sms_pending",
      label: "Calls ready · Texting not ready",
      ok: !smsEnabled,
      level: smsEnabled ? "fail" : "warn",
      detail: smsEnabled
        ? `sms_enabled=true but a2p_registration_status=${a2pStatus}; automatic texting must stay off until registration is approved.`
        : a2pStatus === "rejected"
          ? "Carrier registration was rejected; callers are not receiving automatic texts until Relay re-files and approval is complete."
          : `a2p_registration_status=${a2pStatus}; callers are not receiving automatic texts yet.`,
    };
  }

  if (smsEnabled) {
    return {
      key: "live_sms_on",
      label: "Live · Auto-text on",
      ok: true,
      level: "fail",
      detail: "A2P approved and sms_enabled=true; callers receive automatic missed-call replies.",
    };
  }

  return {
    key: "live_sms_paused",
    label: "Live · Auto-text paused",
    ok: false,
    level: "warn",
    detail:
      "A2P approved and sms_enabled=false by choice. Missed calls still appear in the inbox, but callers are not receiving automatic texts.",
  };
}

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

function env(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function optionalEnv(name) {
  return process.env[name] || null;
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
    /^0+$/.test(digits) ||
    /^1?2?3?4?5?6?7?8?9?0?$/.test(digits)
  );
}

function check(results, ok, label, detail, level = "fail") {
  results.push({ ok, label, detail, level });
}

function statusLine(result) {
  const marker = result.ok ? "PASS" : result.level === "warn" ? "WARN" : "FAIL";
  const detail = result.detail ? ` - ${result.detail}` : "";
  return `[${marker}] ${result.label}${detail}`;
}

async function main() {
  await loadLocalEnv();

  const slug = process.argv[2]?.trim();
  if (!slug) {
    console.error("Usage: npm run verify:account -- <slug>");
    process.exit(1);
  }

  const supabaseUrl = optionalEnv("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
  const supabase = createClient(supabaseUrl, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const results = [];
  let account = null;
  let settings = null;
  let primaryNumber = null;
  let adminUsers = [];

  const { data: accountData, error: accountError } = await supabase
    .from("accounts")
    .select("id, slug, name, status")
    .eq("slug", slug)
    .maybeSingle();

  if (accountError) throw accountError;
  account = accountData;

  check(
    results,
    Boolean(account),
    "account exists",
    account ? `${account.slug} (${account.status})` : `No accounts row found for slug "${slug}".`,
  );

  if (account) {
    check(
      results,
      account.status === "active",
      "account is active",
      account.status === "active" ? null : `Current status is ${account.status}.`,
    );

    const { data: settingsData, error: settingsError } = await supabase
      .from("account_settings")
      .select("account_id, business_name, owner_email, owner_phone_number, sms_enabled, a2p_registration_status")
      .eq("account_id", account.id)
      .maybeSingle();

    if (settingsError) throw settingsError;
    settings = settingsData;

    check(
      results,
      Boolean(settings),
      "account_settings exists",
      settings ? settings.business_name : "Missing account_settings row.",
    );

    const { data: phoneNumbers, error: phoneError } = await supabase
      .from("account_phone_numbers")
      .select("phone_number, is_primary, twilio_sid")
      .eq("account_id", account.id)
      .order("is_primary", { ascending: false });

    if (phoneError) throw phoneError;
    primaryNumber = (phoneNumbers ?? []).find((row) => row.is_primary) ?? null;

    check(
      results,
      Boolean(primaryNumber),
      "primary account_phone_numbers row exists",
      primaryNumber ? normalizePhoneNumber(primaryNumber.phone_number) : "No primary Twilio number row.",
    );

    check(
      results,
      Boolean(primaryNumber) && !isPlaceholderPhone(primaryNumber.phone_number),
      "Twilio number is not a placeholder",
      primaryNumber ? normalizePhoneNumber(primaryNumber.phone_number) : "No number to inspect.",
    );

    const { data: users, error: usersError } = await supabase
      .from("account_users")
      .select("email, role, user_id")
      .eq("account_id", account.id);

    if (usersError) throw usersError;
    adminUsers = (users ?? []).filter((user) => ADMIN_ROLES.has(user.role));

    check(
      results,
      adminUsers.some((user) => Boolean(user.email)),
      "account_users has owner/admin email",
      adminUsers.length
        ? adminUsers.map((user) => `${user.role}:${user.email ?? "missing-email"}`).join(", ")
        : "No owner/admin account_users rows.",
    );
  }

  if (settings) {
    check(
      results,
      Boolean(settings.owner_email),
      "owner_email is set",
      settings.owner_email ?? "Missing owner_email in account_settings.",
    );

    const smsOperatingState = deriveSmsOperatingState(settings);
    check(
      results,
      smsOperatingState.ok,
      `operating state: ${smsOperatingState.label}`,
      smsOperatingState.detail,
      smsOperatingState.level,
    );

    check(
      results,
      Boolean(settings.owner_phone_number) && !isPlaceholderPhone(settings.owner_phone_number),
      "owner phone is not a placeholder",
      settings.owner_phone_number ? normalizePhoneNumber(settings.owner_phone_number) : "Missing owner phone.",
    );
  }

  if (adminUsers.length > 0) {
    check(
      results,
      adminUsers.some((user) => Boolean(user.user_id)),
      "owner/admin Supabase Auth user linked",
      adminUsers.some((user) => Boolean(user.user_id))
        ? "At least one owner/admin has user_id."
        : "Reminder: invite/link a Supabase Auth user before handoff.",
      "warn",
    );
  }

  const failures = results.filter((result) => !result.ok && result.level !== "warn");
  const warnings = results.filter((result) => !result.ok && result.level === "warn");

  console.log(`Relay NW account verification: ${slug}`);
  console.log("");
  for (const result of results) {
    console.log(statusLine(result));
  }
  console.log("");

  if (failures.length > 0) {
    console.log(`Result: FAIL (${failures.length} blocking issue${failures.length === 1 ? "" : "s"})`);
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`Result: PASS with ${warnings.length} reminder${warnings.length === 1 ? "" : "s"}`);
    return;
  }

  console.log("Result: PASS");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
  console.error(`Account verification failed: ${message}`);
  process.exit(1);
});

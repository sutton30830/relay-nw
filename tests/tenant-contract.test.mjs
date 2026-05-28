import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase.sql", import.meta.url), "utf8");
const envTs = await readFile(new URL("../lib/env.ts", import.meta.url), "utf8");
const twilioTs = await readFile(new URL("../lib/twilio.ts", import.meta.url), "utf8");
const authTs = await readFile(new URL("../lib/auth.ts", import.meta.url), "utf8");
const emailTs = await readFile(new URL("../lib/email.ts", import.meta.url), "utf8");
const missedCallTs = await readFile(new URL("../lib/missed-call.ts", import.meta.url), "utf8");
const intakeRouteTs = await readFile(new URL("../app/api/intake/route.ts", import.meta.url), "utf8");
const leadsPageTsx = await readFile(new URL("../app/leads/page.tsx", import.meta.url), "utf8");
const opsPageTsx = await readFile(new URL("../app/ops/page.tsx", import.meta.url), "utf8");
const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");

test("tenant core tables are present", () => {
  for (const table of [
    "public.accounts",
    "public.account_phone_numbers",
    "public.account_users",
    "public.account_settings",
    "public.calls",
    "public.messages",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table.replace(".", "\\.")}`));
  }
});

test("account users can bind Supabase Auth users to accounts", () => {
  assert.match(sql, /alter table public\.account_users add column if not exists user_id uuid/);
  assert.match(sql, /account_users_user_id_unique_idx/);
  assert.match(sql, /account_users_email_idx/);
});

test("email notifications are documented and lazily initialized", () => {
  assert.match(envExample, /RESEND_API_KEY/);
  assert.match(envExample, /ALERT_FROM_EMAIL/);
  assert.match(envExample, /ADMIN_ALERT_EMAIL/);
  assert.match(sql, /owner_email text/);
  assert.match(emailTs, /function getResendClient\(\)/);
  assert.doesNotMatch(emailTs.split("function getResendClient()")[0], /new Resend/);
});

test("missed-call owner notification only follows inserted leads", () => {
  const duplicateReturnIndex = missedCallTs.indexOf('smsStatus: "duplicate"');
  const notifyIndex = missedCallTs.indexOf("notifyOwnerNewMissedCallLead({");
  assert.ok(duplicateReturnIndex > -1);
  assert.ok(notifyIndex > duplicateReturnIndex);
});

test("public intake setup requests attach to the house account and alert admin", () => {
  assert.match(intakeRouteTs, /getDefaultAccountConfig\(\)/);
  assert.match(intakeRouteTs, /if \(!account\.accountId\)/);
  assert.match(intakeRouteTs, /accountId: account\.accountId/);
  assert.match(intakeRouteTs, /notifyAdminNewSetupRequest\(\{/);
});

test("human-facing pages require authenticated account context", () => {
  assert.match(authTs, /export async function requireAccountUser\(\)/);
  assert.match(authTs, /account_users/);
  assert.match(leadsPageTsx, /requireAccountUser\(\)/);
  assert.match(opsPageTsx, /requireAccountUser\(\)/);
  assert.doesNotMatch(leadsPageTsx, /getDefaultAccountConfig/);
  assert.doesNotMatch(opsPageTsx, /getDefaultAccountConfig/);
});

test("business-owned tables carry account_id", () => {
  for (const table of [
    "public.leads",
    "public.webhook_events",
    "public.opt_outs",
    "public.inbound_messages",
    "public.forwarding_health_checks",
  ]) {
    assert.match(sql, new RegExp(`alter table ${table.replace(".", "\\.")} add column if not exists account_id`));
  }
});

test("idempotency indexes are account scoped", () => {
  assert.match(sql, /unique \(account_id, call_sid\)/);
  assert.match(sql, /unique \(account_id, twilio_message_sid\)/);
  assert.match(sql, /opt_outs_account_phone_unique_idx/);
  assert.match(sql, /inbound_messages_account_message_sid_unique_idx/);
});

test("unsafe unsigned Twilio webhooks are blocked in production", () => {
  assert.match(envTs, /ALLOW_UNSIGNED_TWILIO_WEBHOOKS cannot be enabled in production/);
});

test("webhook sanitizer records metadata instead of raw SMS body", () => {
  assert.match(twilioTs, /rejectInvalidTwilioSignature/);
  assert.match(sql, /payload jsonb not null default '\{\}'::jsonb/);
  assert.doesNotMatch(sql, /raw_payload/);
});

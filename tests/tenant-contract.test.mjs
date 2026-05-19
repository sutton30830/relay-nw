import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase.sql", import.meta.url), "utf8");
const envTs = await readFile(new URL("../lib/env.ts", import.meta.url), "utf8");
const twilioTs = await readFile(new URL("../lib/twilio.ts", import.meta.url), "utf8");

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

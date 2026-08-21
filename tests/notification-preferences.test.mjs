import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadPureTsModule(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const script = new vm.Script(`(function(module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(module, module.exports);
  return module.exports;
}

const {
  DEFAULT_OWNER_NOTIFICATION_PREFERENCES,
  normalizeOwnerNotificationPreferences,
  serializeOwnerNotificationPreferences,
} = await loadPureTsModule("lib/notification-preferences.ts");

test("notification defaults preserve Relay's existing delivery behavior", () => {
  assert.deepEqual(DEFAULT_OWNER_NOTIFICATION_PREFERENCES, {
    missedCall: { email: true, sms: true },
    voicemailReady: { email: true, sms: false },
    inboundReply: { email: true, sms: true },
    urgentVoicemailSms: true,
  });
  assert.deepEqual(
    normalizeOwnerNotificationPreferences(null),
    DEFAULT_OWNER_NOTIFICATION_PREFERENCES,
  );
});

test("partial or malformed stored preferences fall back channel by channel", () => {
  assert.deepEqual(normalizeOwnerNotificationPreferences({
    missed_call: { email: false, sms: "no" },
    voicemail_ready: null,
    inbound_reply: [false],
    urgent_voicemail_sms: false,
  }), {
    missedCall: { email: false, sms: true },
    voicemailReady: { email: true, sms: false },
    inboundReply: { email: true, sms: true },
    urgentVoicemailSms: false,
  });
});

test("notification preferences serialize to stable database field names", () => {
  assert.deepEqual(serializeOwnerNotificationPreferences({
    missedCall: { email: true, sms: false },
    voicemailReady: { email: false, sms: true },
    inboundReply: { email: false, sms: false },
    urgentVoicemailSms: false,
  }), {
    missed_call: { email: true, sms: false },
    voicemail_ready: { email: false, sms: true },
    inbound_reply: { email: false, sms: false },
    urgent_voicemail_sms: false,
  });
});

test("schema and owner settings surface persist notification controls", async () => {
  const [schema, migration, settingsPage, settingsControl] = await Promise.all([
    readFile(new URL("../supabase.sql", import.meta.url), "utf8"),
    readFile(new URL("../docs/migrations/2026-08-20-owner-notification-preferences.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/notification-preferences.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /notification_preferences jsonb not null default/);
  assert.match(migration, /add column if not exists notification_preferences/);
  assert.match(settingsPage, /<NotificationPreferences/);
  assert.match(settingsPage, /account\.notificationPreferencesAvailable/);
  assert.match(settingsControl, /field: "missed_call"/);
  assert.match(settingsControl, /field: "voicemail_ready"/);
  assert.match(settingsControl, /field: "inbound_reply"/);
  assert.equal(settingsControl.includes('name={`notification_${event.field}_email`}'), true);
  assert.equal(settingsControl.includes('name={`notification_${event.field}_sms`}'), true);
  assert.match(settingsControl, /required compliance notices always go/);
});
